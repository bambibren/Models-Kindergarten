import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ModelEvent,
  ModelInput,
  ModelStudent,
} from "../src/model/model-provider.js";
import {
  ResponsesApiProvider,
  type ResponsesReasoningConfiguration,
} from "../src/model/responses-api-provider.js";
import { startResponsesMockServer } from "./support/responses-mock-server.js";
import { AgentRuntime, type RunObserver } from "../src/runtime/agent-runtime.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { FileSandbox } from "../src/tools/sandbox.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextSummary } from "@kindergarten/contracts";
import type { PreparedToolCall, ToolOutcome } from "../src/tools/tool-registry.js";
import { ContextAssembler } from "../src/conversation/context-assembler.js";
import type { SessionEntry } from "../src/repository/session-types.js";
import { SessionRepository } from "../src/repository/session-repository.js";
import {
  createProviderOpaqueContinuation,
  type ProviderOpaqueContinuation,
} from "../src/model/provider-continuation.js";

const student: ModelStudent = {
  id: "responses-test",
  name: "Responses Test",
  sizeClass: "large",
  provider: {
    kind: "openai-compatible",
    model: "gpt-5.5",
    baseUrl: "http://127.0.0.1:1/v1",
  },
  generationDefaults: {
    temperature: 0.3,
  },
};

const input: ModelInput = {
  systemPrompt: "你是测试助手。",
  messages: [{ role: "user", content: "分析并读取文件" }],
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

const encryptedSentinel = "ENCRYPTED_REASONING_SENTINEL_MK_20260813";

describe("Responses API reasoning 契约", () => {
  it("自定义连接即使名为 GPT-5.5 也不会默认套用名称 preset", () => {
    expect(() => new ResponsesApiProvider(student, {
      readBearerToken: () => "test-token",
    })).toThrow("缺少入园体检");
  });

  it("将 GPT-5.5 产品档位映射到官方 effort 集合", () => {
    const provider = new ResponsesApiProvider(student, {
      readBearerToken: () => "test-token",
      allowLegacyOfficialPreset: true,
    });

    expect(provider.reasoningCapability).toMatchObject({
      control: "effort_levels",
      adjustable: true,
      supportedProfiles: ["fast", "balanced", "deep", "max"],
      defaultProfile: "balanced",
      native: {
        parameter: "reasoning.effort",
        values: ["low", "medium", "high", "xhigh"],
      },
    });
    expect(provider.nativeReasoning("fast")).toEqual({ effort: "low" });
    expect(provider.nativeReasoning("balanced")).toEqual({ effort: "medium" });
    expect(provider.nativeReasoning("deep")).toEqual({ effort: "high" });
    expect(provider.nativeReasoning("max")).toEqual({ effort: "xhigh" });
  });

  it("发送 reasoning.effort 和 summary=auto，并对非 none 推理安全移除 temperature", async () => {
    const mock = await startResponsesMockServer();
    try {
      const configuredStudent = {
        ...student,
        provider: { ...student.provider, baseUrl: mock.baseUrl },
      };
      const provider = new ResponsesApiProvider(configuredStudent, {
        readBearerToken: () => "test-token",
        allowLegacyOfficialPreset: true,
      });
      const reasoning = {
        schemaVersion: 1,
        requestedProfile: "max",
        resolvedProfile: "max",
        source: "session_override",
        providerKind: "openai-compatible",
        model: "gpt-5.5",
        native: provider.nativeReasoning("max"),
      } as const;

      const events: ModelEvent[] = [];
      for await (const event of provider.stream(
        { ...input, reasoning },
        new AbortController().signal,
      )) {
        events.push(event);
      }

      expect(mock.requests).toHaveLength(1);
      expect(mock.requests[0]?.body).toMatchObject({
        model: "gpt-5.5",
        stream: true,
        store: false,
        reasoning: { effort: "xhigh", summary: "auto" },
        include: ["reasoning.encrypted_content"],
      });
      expect(mock.requests[0]?.body).not.toHaveProperty("temperature");
      expect(events.filter((event) => event.type === "thinking_delta")).not.toHaveLength(0);
      expect(events).toContainEqual({
        type: "usage",
        inputTokens: 80,
        outputTokens: 38,
        cachedInputTokens: 24,
        reasoningOutputTokens: 11,
      });
      expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
    } finally {
      await mock.close();
    }
  });

  it("正式模型流通过 endpointResolver 的地址票据连接，不对 hostname 二次 DNS", async () => {
    const mock = await startResponsesMockServer();
    try {
      const pinnedBaseUrl = new URL(mock.baseUrl);
      pinnedBaseUrl.hostname = "runtime-responses-rebinding.invalid";
      const resolver = vi.fn(async (url: URL) => ({
        url: new URL(url),
        addresses: [{ address: "127.0.0.1", family: 4 as const }],
      }));
      const provider = new ResponsesApiProvider({
        ...student,
        provider: { ...student.provider, baseUrl: pinnedBaseUrl.toString() },
      }, {
        readBearerToken: () => "test-token",
        allowLegacyOfficialPreset: true,
        endpointResolver: resolver,
      });

      const events: ModelEvent[] = [];
      for await (const event of provider.stream(
        { ...input, reasoning: "disabled" },
        new AbortController().signal,
      )) {
        events.push(event);
      }

      expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
      expect(resolver).toHaveBeenCalledTimes(1);
      expect(mock.requests).toHaveLength(1);
    } finally {
      await mock.close();
    }
  });

  it("内部 disabled 显式发送 effort=none、没有 summary，并保留 temperature", () => {
    const provider = new ResponsesApiProvider(student, {
      readBearerToken: () => "test-token",
      allowLegacyOfficialPreset: true,
    });
    const request = JSON.parse(provider.serializeInput({
      ...input,
      reasoning: "disabled",
    }).value) as Record<string, unknown>;
    expect(request).toMatchObject({
      reasoning: { effort: "none" },
      temperature: 0.3,
    });
    expect(request.reasoning).not.toHaveProperty("summary");
  });

  it("拒绝用 [DONE] 替代 Responses 正式终态", async () => {
    const provider = new ResponsesApiProvider(student, {
      readBearerToken: () => "test-token",
      allowLegacyOfficialPreset: true,
    });
    const body = [
      "event: response.output_item.done",
      `data: ${JSON.stringify({
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "fc_unfinished",
          type: "function_call",
          call_id: "call_unfinished",
          name: "read_file",
          arguments: "{\"path\":\"notes/a.md\"}",
          status: "completed",
        },
      })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })));

    const consume = async () => {
      for await (const _event of provider.stream(input, new AbortController().signal)) {
        // 消费完整流以触发终态校验。
      }
    };
    await expect(consume()).rejects.toMatchObject({
      code: "invalid_model_response",
      message: "Responses API 流在终止事件前结束",
    });
  });

  it("非 2xx 错误回显系统脱敏 encrypted_content 和常见凭据字段", async () => {
    const provider = new ResponsesApiProvider(student, {
      readBearerToken: () => "request-bearer-secret",
      allowLegacyOfficialPreset: true,
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: {
        message: "upstream rejected",
        encrypted_content: encryptedSentinel,
        authorization: "Bearer reflected-auth",
        api_key: "reflected-api-key",
        nested: { password: "reflected-password", safe: "visible-detail" },
      },
    }), { status: 400 })));

    const consume = async () => {
      for await (const _event of provider.stream(input, new AbortController().signal)) {}
    };
    await expect(consume()).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes("visible-detail")
        && !message.includes(encryptedSentinel)
        && !message.includes("reflected-auth")
        && !message.includes("reflected-api-key")
        && !message.includes("reflected-password")
        && !message.includes("request-bearer-secret");
    });
  });

  it("response.failed 流式失败不会把请求 token 或敏感字段带入上层错误", async () => {
    const requestToken = "request-token-response-failed-sentinel";
    const reflectedApiKey = "response-failed-api-key-sentinel";
    const reflectedPassword = "response-failed-password-sentinel";
    const provider = new ResponsesApiProvider(student, {
      readBearerToken: () => requestToken,
      allowLegacyOfficialPreset: true,
    });
    const body = [
      `data: ${JSON.stringify({
        type: "response.failed",
        response: {
          error: {
            code: "server_error",
            message: JSON.stringify({
              detail: "response-failed-safe-marker",
              echo: requestToken,
              api_key: reflectedApiKey,
              nested: { password: reflectedPassword },
            }),
          },
        },
      })}`,
      "",
    ].join("\n");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })));

    const consume = async () => {
      for await (const _event of provider.stream(input, new AbortController().signal)) {}
    };
    await expect(consume()).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes("response-failed-safe-marker")
        && message.includes("server_error")
        && message.includes("[REDACTED]")
        && !message.includes(requestToken)
        && !message.includes(reflectedApiKey)
        && !message.includes(reflectedPassword);
    });
  });

  it("顶层 error 流式事件按字段边界脱敏 Bearer、Key、password 和 encrypted_content", async () => {
    const requestToken = "request-token-top-level-error-sentinel";
    const reflectedAuth = "top-level-auth-sentinel";
    const reflectedApiKey = "top-level-api-key-sentinel";
    const reflectedPassword = "top-level-password-sentinel";
    const reflectedEncrypted = "top-level-encrypted-sentinel";
    const provider = new ResponsesApiProvider(student, {
      readBearerToken: () => requestToken,
      allowLegacyOfficialPreset: true,
    });
    const message = [
      "top-level-safe-marker",
      `authorization=Bearer ${reflectedAuth}`,
      `api_key=${reflectedApiKey}`,
      `password=${reflectedPassword}`,
      `encrypted_content=${reflectedEncrypted}`,
      `echo=${requestToken}`,
    ].join("; ");
    const body = [
      `event: error`,
      `data: ${JSON.stringify({ type: "error", code: "service_unavailable", message })}`,
      "",
    ].join("\n");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })));

    const consume = async () => {
      for await (const _event of provider.stream(input, new AbortController().signal)) {}
    };
    await expect(consume()).rejects.toSatisfy((error: unknown) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return errorMessage.includes("top-level-safe-marker")
        && errorMessage.includes("service_unavailable")
        && errorMessage.includes("[REDACTED]")
        && !errorMessage.includes(requestToken)
        && !errorMessage.includes(reflectedAuth)
        && !errorMessage.includes(reflectedApiKey)
        && !errorMessage.includes(reflectedPassword)
        && !errorMessage.includes(reflectedEncrypted);
    });
  });

  it("拒绝超过 1 MiB 的 SSE 单行", async () => {
    const provider = new ResponsesApiProvider(student, {
      readBearerToken: () => "test-token",
      allowLegacyOfficialPreset: true,
    });
    const body = `data: ${"x".repeat(1024 * 1024)}\n\n`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));

    await expect(consume(provider)).rejects.toMatchObject({
      code: "invalid_model_response",
      message: expect.stringContaining("SSE 单行"),
    });
  });

  it("拒绝累计超过 2 MiB 的单个 SSE Event", async () => {
    const provider = new ResponsesApiProvider(student, {
      readBearerToken: () => "test-token",
      allowLegacyOfficialPreset: true,
    });
    const dataLine = `data: ${"x".repeat(700_000)}`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      `${dataLine}\n${dataLine}\n${dataLine}\n\n`,
      { status: 200 },
    )));

    await expect(consume(provider)).rejects.toMatchObject({
      code: "invalid_model_response",
      message: expect.stringContaining("单个 SSE Event"),
    });
  });

  it("拒绝累计超过 64 MiB 的 SSE 流并取消上游 Body", async () => {
    const provider = new ResponsesApiProvider(student, {
      readBearerToken: () => "test-token",
      allowLegacyOfficialPreset: true,
    });
    const encoder = new TextEncoder();
    const chunk = encoder.encode(`:${"x".repeat(512 * 1024 - 3)}\n\n`);
    let sent = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        controller.enqueue(chunk);
        if (sent >= 140) controller.close();
      },
      cancel() { cancelled = true; },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));

    await expect(consume(provider)).rejects.toMatchObject({
      code: "invalid_model_response",
      message: expect.stringContaining("SSE 流"),
    });
    expect(cancelled).toBe(true);
    expect(sent).toBeLessThan(140);
  }, 15_000);

  it("HTTP 错误正文最多读取 64 KiB 后取消，不消费无限诊断流", async () => {
    const provider = new ResponsesApiProvider(student, {
      readBearerToken: () => "test-token",
      allowLegacyOfficialPreset: true,
    });
    const encoder = new TextEncoder();
    const chunk = encoder.encode(`visible-error-marker ${"x".repeat(16 * 1024)}`);
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
        if (pulls >= 100) controller.close();
      },
      cancel() { cancelled = true; },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 400 })));

    await expect(consume(provider)).rejects.toSatisfy((error: unknown) =>
      error instanceof Error && error.message.includes("visible-error-marker"));
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(10);
  });

  it("不猜测未知自定义模型的档位，但接受入园体检的显式映射", () => {
    const customStudent: ModelStudent = {
      ...student,
      provider: { ...student.provider, model: "vendor-reasoner-v2" },
    };
    expect(() => new ResponsesApiProvider(customStudent, {
      readBearerToken: () => "test-token",
    })).toThrow("缺少入园体检");

    const reasoning: ResponsesReasoningConfiguration = {
      capability: {
        schemaVersion: 1,
        control: "effort_levels",
        adjustable: true,
        supportedProfiles: ["fast", "deep"],
        defaultProfile: "deep",
        native: { parameter: "reasoning.effort", values: ["minimal", "high"] },
      },
      efforts: { fast: "minimal", deep: "high" },
    };
    const provider = new ResponsesApiProvider(customStudent, {
      readBearerToken: () => "test-token",
      reasoning,
    });
    expect(provider.nativeReasoning("deep")).toEqual({ effort: "high" });
    expect(() => provider.nativeReasoning("balanced")).toThrow("不支持");
  });

  it("接受体检只确认一个 effort 时生成的 fixed 能力", () => {
    const provider = new ResponsesApiProvider({
      ...student,
      provider: { ...student.provider, model: "single-effort-model" },
    }, {
      readBearerToken: () => "test-token",
      reasoning: {
        capability: {
          schemaVersion: 1,
          control: "fixed",
          adjustable: false,
          supportedProfiles: ["fast"],
          defaultProfile: "fast",
          native: { parameter: "reasoning.effort", values: ["low"] },
        },
        efforts: { fast: "low" },
      },
    });
    expect(provider.nativeReasoning("fast")).toEqual({ effort: "low" });
  });

  it("拒绝与 Responses effort 原生协议不一致的入园能力", () => {
    const customStudent: ModelStudent = {
      ...student,
      provider: { ...student.provider, model: "vendor-budget-model" },
    };
    expect(() => new ResponsesApiProvider(customStudent, {
      readBearerToken: () => "test-token",
      reasoning: {
        capability: {
          schemaVersion: 1,
          control: "token_budget",
          adjustable: true,
          supportedProfiles: ["fast", "deep"],
          defaultProfile: "deep",
          native: { parameter: "thinking_budget", minBudget: 0, maxBudget: 8_192 },
        },
        efforts: { fast: "low", deep: "high" },
      },
    })).toThrow("effort_levels");
  });

  it("在发请求前拒绝属于其他模型的 Turn 快照", () => {
    const provider = new ResponsesApiProvider(student, {
      readBearerToken: () => "test-token",
      allowLegacyOfficialPreset: true,
    });
    expect(() => provider.serializeInput({
      ...input,
      reasoning: {
        schemaVersion: 1,
        requestedProfile: "deep",
        resolvedProfile: "deep",
        source: "session_override",
        providerKind: "openai-compatible",
        model: "other-model",
        native: { effort: "high" },
      },
    })).toThrow("不匹配");
  });

  it("store=false 工具循环原样续接 encrypted output，按 output_index 启动且披露快照脱敏", async () => {
    const mock = await startResponsesMockServer();
    const dir = await mkdtemp(join(tmpdir(), "mk-responses-runtime-"));
    try {
      const configuredStudent = { ...student, provider: { ...student.provider, baseUrl: mock.baseUrl } };
      const provider = new ResponsesApiProvider(configuredStudent, {
        readBearerToken: () => "test-token",
        allowLegacyOfficialPreset: true,
      });
      const sandbox = new FileSandbox(dir);
      await sandbox.initialize();
      await writeFile(join(dir, "context.md"), "context", "utf8");
      await writeFile(join(dir, "theme.md"), "theme", "utf8");
      const observer = new ContinuationObserver();
      const result = await AgentRuntime.fromRegistry(provider, new ToolRegistry(sandbox)).run(
        { text: "读取两份资料", sessionEntries: [] },
        observer,
        new AbortController().signal,
      );

      expect(result.reason).toBe("stop");
      expect(observer.started).toEqual(["notes/context.md", "notes/theme.md"]);
      expect(mock.requests).toHaveLength(2);
      const second = JSON.stringify(mock.requests[1]?.body.input);
      expect(second).toContain(encryptedSentinel);
      expect(second.match(/\"call_id\":\"call_mock_a\"/g)).toHaveLength(2);
      expect(second.match(/\"call_id\":\"call_mock_b\"/g)).toHaveLength(2);
      expect(observer.disclosures.join("\n")).not.toContain(encryptedSentinel);
      expect(provider.serializeInput({
        ...input,
        messages: await new ContextAssembler().build(continuationHistory(), "next"),
      }).value)
        .not.toContain(encryptedSentinel);
    } finally {
      await mock.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("Session continuation 重建时保留 opaque→tool outputs 顺序且不重复可见投影", async () => {
    const entries = continuationHistory();
    const messages = await new ContextAssembler().build(entries, "下一轮");
    expect(messages.map((message) => message.role)).toEqual([
      "user", "assistant", "tool", "tool", "user",
    ]);
    expect(responsesItems(messages[1]?.providerOpaqueContinuation)[0]).toMatchObject({
      type: "reasoning",
      encrypted_content: encryptedSentinel,
    });
    expect(messages[1]?.toolCalls).toBeUndefined();
    expect(messages[2]?.toolCallId).toBe("call_mock_a");
    expect(messages[3]?.toolCallId).toBe("call_mock_b");

    const provider = new ResponsesApiProvider(student, {
      readBearerToken: () => "test-token",
      allowLegacyOfficialPreset: true,
    });
    const disclosed = provider.serializeContext({ kind: "messages", messages }).value;
    expect(disclosed).not.toContain(encryptedSentinel);
    expect(disclosed).toContain("providerOpaque");
  });

  it("同名 Tool Call 只在所属 Turn 隐藏，且 continuation 与全部 Tool outputs 原子裁剪", async () => {
    const now = new Date().toISOString();
    const prior = toolEntry("call_mock_a", "prior/same-id.md", now);
    prior.turnId = "t0";
    const entries = [prior, ...continuationHistory()];
    const messages = await new ContextAssembler([], 4).build(entries, "当前问题");

    // max=4 的理论切点落在 continuation 组中间；实现必须扩回组首并保留全部 outputs。
    expect(messages.map((message) => message.role)).toEqual([
      "assistant", "tool", "tool", "user",
    ]);
    expect(messages[0]?.providerOpaqueContinuation).toBeDefined();
    expect(messages.slice(1, 3).map((message) => message.toolCallId)).toEqual([
      "call_mock_a", "call_mock_b",
    ]);

    const withoutTruncation = await new ContextAssembler([], 20).build(entries, "当前问题");
    expect(withoutTruncation[0]?.toolCalls?.[0]?.id).toBe("call_mock_a");
    expect(withoutTruncation[1]?.content).toBe("prior/same-id.md");
  });

  it("Session 落盘重载后仍能为下一 Turn 恢复完整 continuation，通用观察只保留占位", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mk-responses-session-"));
    try {
      const first = new SessionRepository(dir);
      const session = await first.create({
        cwd: "/workspace",
        ownerId: "owner",
        purpose: "chat",
        modelStudentId: "responses-test",
        agentId: "agent",
      });
      await first.appendMany(session.id, continuationHistory());

      const reloaded = await new SessionRepository(dir).get(session.id);
      const built = await new ContextAssembler().buildObserved(
        reloaded.sessionEntries,
        "跨 Turn 继续",
        new AbortController().signal,
      );
      expect(responsesItems(built.messages[1]?.providerOpaqueContinuation)[0]).toMatchObject({
        encrypted_content: encryptedSentinel,
      });
      expect(JSON.stringify(built.observations)).not.toContain(encryptedSentinel);
      expect(JSON.stringify(built.observations)).toContain("provider continuation:");
      expect(JSON.stringify(built.observations)).toContain("2 tools");

      const provider = new ResponsesApiProvider(student, {
        readBearerToken: () => "test-token",
        allowLegacyOfficialPreset: true,
      });
      const request = JSON.parse(provider.serializeInput({ ...input, messages: built.messages }).value) as Record<string, unknown>;
      expect(JSON.stringify(request)).not.toContain(encryptedSentinel);
      expect(JSON.stringify(request.input)).toContain("providerOpaque");
      expect(JSON.stringify(await new SessionRepository(dir).getPublic(session.id)))
        .not.toContain(encryptedSentinel);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("拒绝把其他模型的 opaque continuation 注入当前 Responses 请求", () => {
    const provider = new ResponsesApiProvider(student, {
      readBearerToken: () => "test-token",
      allowLegacyOfficialPreset: true,
    });
    const continuation = continuationHistory().find((entry) => entry.type === "provider_continuation");
    if (!continuation || continuation.type !== "provider_continuation") throw new Error("fixture 无效");
    expect(() => provider.serializeInput({
      ...input,
      messages: [{
        role: "assistant",
        content: "",
        providerOpaqueContinuation: {
          ...continuation.continuation,
          model: "other-model",
        },
      }],
    })).toThrow("不匹配");
  });

  it("相同模型名也拒绝跨 ModelStudent 或跨协议消费 continuation", () => {
    const provider = new ResponsesApiProvider(student, {
      readBearerToken: () => "test-token",
      allowLegacyOfficialPreset: true,
    });
    const continuation = continuationHistory().find((entry) => entry.type === "provider_continuation");
    if (!continuation || continuation.type !== "provider_continuation") throw new Error("fixture 无效");
    for (const wrongIdentity of [
      { modelStudentId: "same-model-other-endpoint" },
      { protocol: "openai_chat_completions" },
    ]) {
      expect(() => provider.serializeInput({
        ...input,
        messages: [{
          role: "assistant",
          content: "",
          providerOpaqueContinuation: {
            ...continuation.continuation,
            ...wrongIdentity,
          },
        }],
      })).toThrow("不匹配");
    }
  });
});

class ContinuationObserver implements RunObserver {
  started: string[] = [];
  disclosures: string[] = [];
  async context(summary: ContextSummary): Promise<void> { this.disclosures.push(JSON.stringify(summary)); }
  async modelRoundStarted(facts: import("../src/runtime/agent-runtime.js").RuntimeModelRoundSnapshot): Promise<void> {
    this.disclosures.push(facts.providerInput.value);
  }
  async text(): Promise<void> {}
  async thought(): Promise<void> {}
  async roundComplete(): Promise<void> {}
  async toolStart(call: PreparedToolCall): Promise<void> {
    this.started.push(String(call.arguments.path));
  }
  async toolFinish(): Promise<void> {}
  async requestPermission(): Promise<boolean> { return true; }
  async askUser(): Promise<string> { return ""; }
}

function continuationHistory(): SessionEntry[] {
  const now = new Date().toISOString();
  const items = [
    { id: "rs", type: "reasoning", encrypted_content: encryptedSentinel },
    { id: "fc-a", type: "function_call", call_id: "call_mock_a", name: "read_file", arguments: "{\"path\":\"notes/context.md\"}" },
    { id: "fc-b", type: "function_call", call_id: "call_mock_b", name: "read_file", arguments: "{\"path\":\"notes/theme.md\"}" },
  ];
  const continuation = createProviderOpaqueContinuation({
    modelStudentId: "responses-test",
    providerKind: "openai-compatible",
    protocol: "openai_responses",
    model: "gpt-5.5",
    format: "openai-responses-output-v1",
    payload: { items },
    correlation: {
      messageIds: ["th1"],
      toolCallIds: ["call_mock_a", "call_mock_b"],
    },
  });
  return [
    { type: "message", role: "user", text: "读取", turnId: "t1", messageId: "u1", createdAt: now },
    { type: "thought", text: "可见摘要", turnId: "t1", messageId: "th1", createdAt: now },
    { type: "provider_continuation", turnId: "t1", roundIndex: 0, continuation, createdAt: now },
    toolEntry("call_mock_a", "notes/context.md", now),
    toolEntry("call_mock_b", "notes/theme.md", now),
  ];
}

function responsesItems(continuation: ProviderOpaqueContinuation | undefined): Record<string, unknown>[] {
  if (!continuation || typeof continuation.payload !== "object" || continuation.payload === null || Array.isArray(continuation.payload)) return [];
  const items = continuation.payload.items;
  return Array.isArray(items) ? items as Record<string, unknown>[] : [];
}

async function consume(provider: ResponsesApiProvider): Promise<void> {
  for await (const _event of provider.stream(input, new AbortController().signal)) {
    // Consume the complete stream so transport and terminal guards execute.
  }
}

function toolEntry(id: string, path: string, createdAt: string): SessionEntry {
  return {
    type: "tool_call", turnId: "t1", toolCallId: id, title: "读取", name: "read_file",
    kind: "read", status: "completed", rawInput: { path }, rawOutput: { content: path },
    modelContent: path, outcomeStatus: "success", content: [], locations: [], createdAt,
  };
}
