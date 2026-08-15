import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelEvent, ModelInput, ModelStudent } from "../src/model/model-provider.js";
import { OllamaProvider } from "../src/model/ollama-provider.js";
import { createProviderOpaqueContinuation } from "../src/model/provider-continuation.js";

const student: ModelStudent = {
  id: "ollama-test",
  name: "Ollama Test",
  sizeClass: "small",
  provider: {
    kind: "ollama",
    model: "qwen3:8b",
    baseUrl: "http://127.0.0.1:11434",
  },
  generationDefaults: {
    temperature: 0.2,
  },
};

const input: ModelInput = {
  systemPrompt: "你是测试助手。",
  messages: [
    { role: "user", content: "读取 a.txt" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ name: "read_file", arguments: { path: "a.txt" } }],
    },
    { role: "tool", content: "文件内容", toolName: "read_file", toolCallId: "call-1" },
  ],
  tools: [{
    type: "function",
    function: {
      name: "read_file",
      description: "读取文件",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  }],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Ollama Provider 上下文序列化", () => {
  it("只声明 think 布尔开关可以忠实表达的两个档位", () => {
    const provider = new OllamaProvider(student);
    expect(provider.reasoningCapability).toMatchObject({
      control: "toggle",
      adjustable: true,
      supportedProfiles: ["fast", "balanced"],
      defaultProfile: "balanced",
    });
    expect(provider.nativeReasoning("fast")).toEqual({ think: false });
    expect(provider.nativeReasoning("balanced")).toEqual({ think: true });
    expect(() => provider.nativeReasoning("deep")).toThrow("不支持");
  });

  it("按 Ollama Chat API 的实际字段序列化 system、tools 和 messages", () => {
    const provider = new OllamaProvider(student);

    expect(JSON.parse(provider.serializeContext({
      kind: "system",
      content: input.systemPrompt,
    }).value)).toEqual({ role: "system", content: "你是测试助手。" });

    expect(JSON.parse(provider.serializeContext({
      kind: "tools",
      tools: input.tools,
    }).value)).toEqual(input.tools);

    expect(JSON.parse(provider.serializeContext({
      kind: "messages",
      messages: input.messages,
    }).value)).toEqual([
      { role: "user", content: "读取 a.txt" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "read_file", arguments: { path: "a.txt" } } }],
      },
      { role: "tool", content: "文件内容", tool_name: "read_file" },
    ]);
  });

  it("展示快照与发送给 Ollama 的请求使用同一份转换结果", async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response([
        JSON.stringify({ message: { content: "完成" }, done: false }),
        JSON.stringify({ message: { content: "" }, done: true }),
        "",
      ].join("\n"), { status: 200 });
    }));
    const provider = new OllamaProvider(student);

    for await (const _event of provider.stream(input, new AbortController().signal)) {
      // 消费完整流，确保请求构造与解析都经过真实路径。
    }

    expect(body?.messages).toEqual([
      JSON.parse(provider.serializeContext({
        kind: "system",
        content: input.systemPrompt,
      }).value),
      ...JSON.parse(provider.serializeContext({
        kind: "messages",
        messages: input.messages,
      }).value),
    ]);
    expect(body?.tools).toEqual(JSON.parse(provider.serializeContext({
      kind: "tools",
      tools: input.tools,
    }).value));
    expect(body?.think).toBe(true);
  });

  it("把 Ollama done_reason=length 映射为通用截断原因", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response([
      JSON.stringify({ message: { content: "尚未完成" }, done: false }),
      JSON.stringify({ message: { content: "" }, done: true, done_reason: "length" }),
      "",
    ].join("\n"), { status: 200 })));
    const provider = new OllamaProvider(student);
    const events: ModelEvent[] = [];

    for await (const event of provider.stream(input, new AbortController().signal)) {
      events.push(event);
    }

    expect(events.at(-1)).toEqual({ type: "finish", reason: "length" });
  });

  it("标注工作表可关闭推理，但普通聊天默认保持推理", () => {
    const provider = new OllamaProvider(student);
    expect(JSON.parse(provider.serializeInput({ ...input, reasoning: "disabled" }).value).think).toBe(false);
    expect(JSON.parse(provider.serializeInput(input).value).think).toBe(true);
  });

  it("将 Turn 冻结的原生 think 快照发送给 Ollama", () => {
    const provider = new OllamaProvider(student);
    const request = JSON.parse(provider.serializeInput({
      ...input,
      reasoning: {
        schemaVersion: 1,
        requestedProfile: "fast",
        resolvedProfile: "fast",
        source: "session_override",
        providerKind: "ollama",
        model: "qwen3:8b",
        native: provider.nativeReasoning("fast"),
      },
    }).value);
    expect(request.think).toBe(false);
  });

  it("明确标记被裁剪来源没有进入当前模型请求", () => {
    const provider = new OllamaProvider(student);
    expect(JSON.parse(provider.serializeContext({
      kind: "omitted",
      sourceIds: ["message-old"],
    }).value)).toEqual({ sent: false, sourceIds: ["message-old"] });
  });

  it("遇到其他 Provider 的 continuation 时明确拒绝，不序列化为空 assistant", () => {
    const provider = new OllamaProvider(student);
    expect(() => provider.serializeInput({
      ...input,
      messages: [{
        role: "assistant",
        content: "",
        providerOpaqueContinuation: createProviderOpaqueContinuation({
          modelStudentId: "responses-test",
          providerKind: "openai-compatible",
          protocol: "openai_responses",
          model: "gpt-5.5",
          format: "openai-responses-output-v1",
          payload: { items: [{ type: "reasoning", id: "reasoning-1" }] },
        }),
      }],
    })).toThrowError(expect.objectContaining({
      name: "ModelProviderError",
      code: "invalid_model_response",
      retryable: false,
      message: expect.stringContaining("不匹配"),
    }));
  });
});
