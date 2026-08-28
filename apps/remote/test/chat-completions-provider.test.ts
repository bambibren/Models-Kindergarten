import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ModelEvent,
  ModelInput,
  ModelStudent,
} from "../src/model/model-provider.js";
import {
  ChatCompletionsProvider,
  chatCompletionsApiUrl,
  type ChatCompletionsReasoningConfiguration,
} from "../src/model/chat-completions-provider.js";
import { startChatCompletionsMockServer } from "./support/chat-completions-mock-server.js";
import { AgentRuntime, type RunObserver } from "../src/runtime/agent-runtime.js";
import { FileSandbox } from "../src/tools/sandbox.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import type { SessionEntry } from "../src/repository/session-types.js";

const toggleReasoning: ChatCompletionsReasoningConfiguration = {
  capability: {
    schemaVersion: 1,
    control: "toggle",
    adjustable: true,
    supportedProfiles: ["fast", "balanced"],
    defaultProfile: "balanced",
    native: { parameter: "enable_thinking", values: [false, true] },
  },
  nativeByProfile: {
    fast: { enable_thinking: false },
    balanced: { enable_thinking: true },
  },
};

const tools: ModelInput["tools"] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a sandbox file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write a sandbox file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
];

afterEach(/** 在每个测试后释放临时资源，保证后续场景从干净状态开始。 */
() => {
  vi.unstubAllGlobals();
});

describe("ChatCompletionsProvider", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("保留 /v1 前缀并生成标准 Chat Completions 请求", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const provider = createProvider(student("http://127.0.0.1:1/v1"));
    const value = JSON.parse(provider.serializeInput({
      systemPrompt: "You are a test assistant.",
      messages: [
        { role: "user", content: "read" },
        {
          role: "assistant",
          content: "",
          thinking: "need a tool",
          toolCalls: [{ id: "call_1", name: "read_file", arguments: { path: "notes/a.md" } }],
        },
        {
          role: "tool",
          content: JSON.stringify({ text: "A" }),
          toolName: "read_file",
          toolCallId: "call_1",
        },
      ],
      tools,
      reasoning: reasoningSnapshot("balanced", { enable_thinking: true }),
    }).value) as Record<string, unknown>;

    expect(chatCompletionsApiUrl("https://api.siliconflow.cn/v1").href)
      .toBe("https://api.siliconflow.cn/v1/chat/completions");
    expect(value).toMatchObject({
      model: "same-model-id",
      stream: true,
      stream_options: { include_usage: true },
      enable_thinking: true,
      messages: [
        { role: "system" },
        { role: "user", content: "read" },
        {
          role: "assistant",
          content: null,
          reasoning_content: "need a tool",
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: "{\"path\":\"notes/a.md\"}" },
          }],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          name: "read_file",
          content: "{\"text\":\"A\"}",
        },
      ],
    });
  });

  it("按 tool_call.index 聚合乱序参数并以稳定原始顺序一次完成", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const mock = await startChatCompletionsMockServer({ thinking: "toggle" });
    try {
      const provider = createProvider(student(mock.baseUrl));
      const events = await collect(provider.stream({
        systemPrompt: "You are a test assistant.",
        messages: [{ role: "user", content: "use two tools" }],
        tools,
        reasoning: reasoningSnapshot("balanced", { enable_thinking: true }),
      }, new AbortController().signal));

      expect(events.filter(/** 构造「toEqual」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(event) => event.type === "tool_calls")).toEqual([{
        type: "tool_calls",
        calls: [
          {
            id: "call_a",
            index: 0,
            name: "read_file",
            arguments: { path: "notes/a.md" },
          },
          {
            id: "call_b",
            index: 1,
            name: "write_file",
            arguments: { path: "notes/b.md", content: "B" },
          },
        ],
      }]);
      expect(events).toContainEqual({
        type: "usage",
        inputTokens: 41,
        outputTokens: 17,
        cachedInputTokens: 9,
        reasoningOutputTokens: 5,
      });
      expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
      expect(mock.requests[0]).toMatchObject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: "Bearer test-token" },
      });
    } finally {
      await mock.close();
    }
  });

  it("把 assistant tool_calls 与 tool_call_id 结果续接为下一轮正文", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const mock = await startChatCompletionsMockServer({ thinking: "toggle" });
    try {
      const provider = createProvider(student(mock.baseUrl));
      const events = await collect(provider.stream({
        systemPrompt: "You are a test assistant.",
        messages: [
          { role: "user", content: "use a tool" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "call_probe", name: "read_file", arguments: { path: "notes/a.md" } }],
          },
          {
            role: "tool",
            content: JSON.stringify({ ok: true }),
            toolName: "read_file",
            toolCallId: "call_probe",
          },
        ],
        tools,
        reasoning: reasoningSnapshot("fast", { enable_thinking: false }),
      }, new AbortController().signal));

      expect(events.filter(/** 构造「map」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(event) => event.type === "text_delta")
        .map(/** 构造「join」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(event) => event.type === "text_delta" ? event.text : "").join(""))
        .toBe("MK_TOOL_CONTINUATION_OK");
      expect(mock.requests[0]?.body).toMatchObject({
        enable_thinking: false,
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "assistant", tool_calls: expect.any(Array) }),
          expect.objectContaining({ role: "tool", tool_call_id: "call_probe" }),
        ]),
      });
    } finally {
      await mock.close();
    }
  });

  it("流式输出 reasoning_content 与四维 token 用量", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const mock = await startChatCompletionsMockServer({ thinking: "toggle" });
    try {
      const events = await collect(createProvider(student(mock.baseUrl)).stream({
        systemPrompt: "You are a test assistant.",
        messages: [{ role: "user", content: "think" }],
        tools: [],
        reasoning: reasoningSnapshot("balanced", { enable_thinking: true }),
      }, new AbortController().signal));
      expect(events.filter(/** 构造「toEqual」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(event) => event.type === "thinking_delta")).toEqual([
        { type: "thinking_delta", text: "先计算，" },
        { type: "thinking_delta", text: "再作答。" },
      ]);
      expect(events).toContainEqual({
        type: "usage",
        inputTokens: 41,
        outputTokens: 17,
        cachedInputTokens: 9,
        reasoningOutputTokens: 5,
      });
    } finally {
      await mock.close();
    }
  });

  it("finish_reason 之后缺少 [DONE] 仍拒绝提交本轮", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const mock = await startChatCompletionsMockServer({ omitDone: true });
    try {
      await expect(collect(createProvider(student(mock.baseUrl)).stream({
        systemPrompt: "You are a test assistant.",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      }, new AbortController().signal))).rejects.toMatchObject({
        code: "invalid_model_response",
        message: "Chat Completions API 流在 [DONE] 前结束",
      });
    } finally {
      await mock.close();
    }
  });

  it("HTTP 与 SSE 错误都不会泄露 Bearer 或反射敏感字段", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const mock = await startChatCompletionsMockServer();
    try {
      for (const model of ["http-error", "sse-error"] as const) {
        const consume = collect(createProvider(student(mock.baseUrl, model)).stream({
          systemPrompt: "You are a test assistant.",
          messages: [{ role: "user", content: "hello" }],
          tools: [],
        }, new AbortController().signal));
        await expect(consume).rejects.toSatisfy(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          return !message.includes("test-token")
            && !message.includes("reflected-api-key")
            && !message.includes("reflected-key")
            && !message.includes("reflected-password");
        });
      }
    } finally {
      await mock.close();
    }
  });

  it("拒绝超过上限的 SSE 单行", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const mock = await startChatCompletionsMockServer();
    try {
      await expect(collect(createProvider(student(mock.baseUrl, "oversized-line")).stream({
        systemPrompt: "You are a test assistant.",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      }, new AbortController().signal))).rejects.toMatchObject({
        code: "invalid_model_response",
        message: "Chat Completions API SSE 单行超过大小限制",
      });
    } finally {
      await mock.close();
    }
  });

  it("使用 endpointResolver 的固定地址票据且保留原 hostname", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const mock = await startChatCompletionsMockServer();
    try {
      const baseUrl = new URL(mock.baseUrl);
      baseUrl.hostname = "siliconflow-rebinding.invalid";
      const resolver = vi.fn(/** 构造「resolver」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async (url: URL) => ({
        url: new URL(url),
        addresses: [{ address: "127.0.0.1", family: 4 as const }],
      }));
      const provider = new ChatCompletionsProvider(student(baseUrl.toString()), {
        readBearerToken: /** 构造「readBearerToken」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => "test-token",
        reasoning: toggleReasoning,
        endpointResolver: resolver,
      });
      const events = await collect(provider.stream({
        systemPrompt: "You are a test assistant.",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      }, new AbortController().signal));
      expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
      expect(resolver).toHaveBeenCalledTimes(1);
    } finally {
      await mock.close();
    }
  });

  it("原样传播 AbortSignal 取消", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(collect(createProvider(student("http://127.0.0.1:1/v1")).stream({
      systemPrompt: "You are a test assistant.",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    }, controller.signal))).rejects.toMatchObject({ name: "AbortError" });
  });

  it("SiliconFlow 不使用伪造的固定消息条数限制", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const mock = await startChatCompletionsMockServer();
    const dir = await mkdtemp(join(tmpdir(), "mk-chat-message-limit-"));
    try {
      const sandbox = new FileSandbox(dir);
      await sandbox.initialize();
      await sandbox.writeText("notes/a.md", "A");
      const provider = createProvider(student(mock.baseUrl));
      const result = await AgentRuntime.fromRegistry(
        provider,
        new ToolRegistry(sandbox),
      ).run({
        text: "use the available tools",
        sessionEntries: longMessageHistory(18),
      }, noopRunObserver(), new AbortController().signal);

      expect(result.reason).toBe("stop");
      expect(mock.requests).toHaveLength(2);
      const outbound = mock.requests.map(/** 构造「outbound」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(item) => {
        const messages = item.body.messages;
        if (!Array.isArray(messages)) throw new Error("mock request messages missing");
        return messages as Array<Record<string, unknown>>;
      });
      expect(outbound[0]?.length).toBeGreaterThan(10);
      expect(outbound[1]?.length).toBeGreaterThan(10);
      expect(outbound[1]).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "use the available tools" }),
        expect.objectContaining({ role: "assistant", tool_calls: expect.any(Array) }),
        expect.objectContaining({ role: "tool", tool_call_id: "call_a" }),
        expect.objectContaining({ role: "tool", tool_call_id: "call_b" }),
      ]));
    } finally {
      await mock.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** 构造「student」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function student(baseUrl: string, model = "same-model-id"): ModelStudent {
  return {
    id: "siliconflow-test",
    name: "SiliconFlow Test",
    sizeClass: "large",
    provider: { kind: "siliconflow", model, baseUrl },
    generationDefaults: {},
  };
}

/** 构造「createProvider」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function createProvider(value: ModelStudent): ChatCompletionsProvider {
  return new ChatCompletionsProvider(value, {
    readBearerToken: /** 构造「readBearerToken」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => "test-token",
    reasoning: toggleReasoning,
    includeStreamUsage: true,
  });
}

/** 构造「reasoningSnapshot」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function reasoningSnapshot(
  profile: "fast" | "balanced",
  native: Record<string, string | number | boolean>,
): Exclude<ModelInput["reasoning"], "disabled" | undefined> {
  return {
    schemaVersion: 1,
    requestedProfile: profile,
    resolvedProfile: profile,
    source: "model_default",
    providerKind: "siliconflow",
    model: "same-model-id",
    native,
  };
}

/** 构造「collect」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async function collect(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const result: ModelEvent[] = [];
  for await (const event of stream) result.push(event);
  return result;
}

/** 构造「longMessageHistory」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function longMessageHistory(count: number): SessionEntry[] {
  const createdAt = new Date("2026-08-14T00:00:00.000Z").toISOString();
  return Array.from({ length: count }, /** 构造「longMessageHistory」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(_, index) => ({
    type: "message" as const,
    role: index % 2 === 0 ? "user" as const : "assistant" as const,
    text: `history-${index}`,
    turnId: `history-turn-${Math.floor(index / 2)}`,
    messageId: `history-message-${index}`,
    createdAt,
  }));
}

/** 构造「noopRunObserver」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function noopRunObserver(): RunObserver {
  return {
    /** 构造「context」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async context() {},
    /** 构造「text」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async text() {},
    /** 构造「thought」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async thought() {},
    /** 构造「roundComplete」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async roundComplete() {},
    /** 构造「toolStart」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async toolStart() {},
    /** 构造「toolFinish」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async toolFinish() {},
    /** 构造「requestPermission」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async requestPermission() { return true; },
    /** 构造「askUser」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async askUser() { return ""; },
  };
}
