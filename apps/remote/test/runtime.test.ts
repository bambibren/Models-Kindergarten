import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PRODUCT_CONFIG, type ContextSummary } from "@kindergarten/contracts";
import { ContextAssembler } from "../src/conversation/context-assembler.js";
import type {
  ModelContextFragment,
  ModelContextSerialization,
  ModelEvent,
  ModelInput,
  ModelProvider,
  ModelStudent,
} from "../src/model/model-provider.js";
import type { SessionEntry } from "../src/repository/session-types.js";
import { AgentRunner, AgentRuntime, type RunObserver } from "../src/runtime/agent-runtime.js";
import { createSmallModelRepeatedInvalidToolCallGuard } from "../src/runtime/repeated-invalid-tool-call-guard.js";
import { noopRuntimeObservationSink } from "@kindergarten/runtime-observation";
import { ModelProviderError } from "../src/model/model-error.js";
import { ProcessSandbox } from "../src/tools/process-sandbox.js";
import { FileSandbox } from "../src/tools/sandbox.js";
import { prepareToolCall } from "../src/tools/tool-call-preparer.js";
import type { PreparedToolCall, ToolOutcome } from "../src/tools/tool-registry.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { ToolCallLedger, ToolRuntime } from "../src/tools/tool-runtime.js";
import { WebAccess } from "../src/tools/web-access.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("V1.6 Agent Runtime", () => {
  it("成功工具被重复提议时每次都真实执行，不复用之前结果", async () => {
    const sandbox = await makeSandbox();
    const provider = new RepeatingProvider("write_file", {
      path: "repeat.txt",
      content: "只写一次",
    });
    const observer = new TestObserver(true);
    const runtime = AgentRuntime.fromRegistry(provider, new ToolRegistry(sandbox));

    const result = await runtime.run(
      { text: "重复写入", sessionEntries: [] },
      observer,
      new AbortController().signal,
    );

    expect(result.reason).toBe("stop");
    expect(result.usage).toMatchObject({
      modelRequests: 4,
      inputTokens: 410,
      outputTokens: 40,
    });
    expect(result.usage.rounds).toHaveLength(4);
    expect(observer.permissionCount).toBe(3);
    expect(observer.outcomes.map((item) => item.status)).toEqual([
      "success",
      "success",
      "success",
    ]);
    expect(await readFile(join(sandbox.root, "repeat.txt"), "utf8")).toBe("只写一次");
    expect(observer.textOutput).toContain("模型已完成重复调用");
    expect(observer.contextSummaries).toHaveLength(1);
    expect(observer.contextSummaries[0]?.items.map((item) => item.kind)).toEqual([
      "system_instruction",
      "available_tools",
    ]);
    expect(observer.contextSummaries[0]?.items.every((item) => item.raw?.provider === "ollama"))
      .toBe(true);
    expect(JSON.stringify(observer.contextSummaries[0])).not.toContain("重复写入");
  });

  it("权限拒绝后相同命令再次调用仍独立请求授权", async () => {
    const sandbox = await makeSandbox();
    const provider = new RepeatingProvider("run_command", {
      command: "printf forbidden > denied.txt",
    });
    const observer = new TestObserver(false);
    const runtime = AgentRuntime.fromRegistry(provider, new ToolRegistry(sandbox));

    const result = await runtime.run(
      { text: "运行命令", sessionEntries: [] },
      observer,
      new AbortController().signal,
    );

    expect(result.reason).toBe("stop");
    expect(observer.permissionCount).toBe(3);
    expect(observer.outcomes.map((item) => item.status)).toEqual([
      "denied",
      "denied",
      "denied",
    ]);
    await expect(readFile(join(sandbox.root, "denied.txt"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("同一 SessionEntry 源分别投影历史工具结果和当前用户消息", async () => {
    const entries: SessionEntry[] = [
      message("user", "请读取文件", "m1"),
      {
        type: "tool_call",
        turnId: "t1",
        toolCallId: "tc1",
        title: "读取 a.txt",
        name: "read_file",
        kind: "read",
        status: "completed",
        rawInput: { path: "a.txt" },
        rawOutput: { content: "历史结果" },
        modelContent: "历史结果",
        outcomeStatus: "success",
        content: [],
        locations: [],
        createdAt: new Date().toISOString(),
      },
    ];
    const modelMessages = await new ContextAssembler().build(entries, "继续");
    expect(modelMessages).toMatchObject([
      { role: "user", content: "请读取文件" },
      { role: "assistant", toolCalls: [{ id: "tc1", name: "read_file" }] },
      { role: "tool", toolCallId: "tc1", content: "历史结果" },
      { role: "user", content: "继续" },
    ]);
  });

  it("Tool 清单使用 web_fetch 且完全没有 Plan 能力", async () => {
    const registry = new ToolRegistry(await makeSandbox());
    const names = registry.definitions.map((item) => item.function.name);
    expect(names).toEqual([
      "list_files",
      "read_file",
      "write_file",
      "run_command",
      "web_search",
      "web_fetch",
      "ask_user",
    ]);
    expect(names).not.toContain("update_plan");
  });

  it("写文件权限原样遵守 Agent 配置，终端仍保持强制询问", async () => {
    const sandbox = await makeSandbox();
    const write = (permission: "allow" | "ask" | "deny") => new ToolRegistry(
      sandbox,
      undefined,
      undefined,
      new Map([
        ["write_file", { enabled: true, permission }],
        ["run_command", { enabled: true, permission: "allow" as const }],
      ]),
    );

    for (const permission of ["allow", "ask", "deny"] as const) {
      expect(write(permission).prepare({
        id: `write-${permission}`,
        name: "write_file",
        arguments: { path: "index.html", content: "ok" },
      }, "fallback").permission).toBe(permission);
    }
    expect(write("ask").prepare({
      id: "command",
      name: "run_command",
      arguments: { command: "pwd" },
    }, "fallback").permission).toBe("always_ask");
  });

  it("普通参数错误展开真实 Schema，不猜测或改写模型参数", async () => {
    const registry = new ToolRegistry(await makeSandbox());
    const prepared = prepareToolCall(registry, {
      name: "read_file",
      arguments: { fileName: "a.txt" },
    }, "invalid-read");
    const observer = new TestObserver(true);
    const result = await new ToolRuntime(registry).executeBatch(
      [prepared],
      observer,
      new ToolCallLedger(),
      new AbortController().signal,
    );
    const raw = result.outcomes[0]?.rawOutput as {
      validation_errors?: Array<{ keyword?: string; parameter?: string }>;
      schema_correction?: {
        expected_schema?: { required?: string[]; additionalProperties?: boolean };
      };
      argument_correction?: unknown;
    };

    expect(raw.validation_errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyword: "required", parameter: "path" }),
      expect.objectContaining({ keyword: "additionalProperties", parameter: "fileName" }),
    ]));
    expect(raw.schema_correction?.expected_schema).toMatchObject({
      required: ["path"],
      additionalProperties: false,
    });
    expect(raw.argument_correction).toBeUndefined();
  });

  it("无效参数的去重键不受对象字段顺序影响", async () => {
    const registry = new ToolRegistry(await makeSandbox());
    const first = prepareToolCall(registry, {
      name: "read_file",
      arguments: { fileName: "a.txt", extra: true },
    }, "invalid-first");
    const second = prepareToolCall(registry, {
      name: "read_file",
      arguments: { extra: true, fileName: "a.txt" },
    }, "invalid-second");

    expect(first.dedupeKey).toBe(second.dedupeKey);
  });

  it.runIf(process.platform === "darwin")("终端允许沙箱内写入并拒绝沙箱外写入", async () => {
    const sandbox = await makeSandbox();
    const processSandbox = new ProcessSandbox(sandbox);
    const signal = new AbortController().signal;
    const inside = await processSandbox.run("printf ok > inside.txt", ".", 5_000, signal);
    expect(inside.exitCode).toBe(0);
    expect(inside.changedFiles).toEqual(["inside.txt"]);
    expect(inside.deletedFiles).toEqual([]);
    expect(await readFile(join(sandbox.root, "inside.txt"), "utf8")).toBe("ok");

    const registry = new ToolRegistry(sandbox, processSandbox);
    const update = await registry.execute(registry.prepare({
      id: "command-update",
      name: "run_command",
      arguments: { command: "printf changed > inside.txt" },
    }, "fallback"), { signal, askUser: async () => "" });
    expect(update.effects?.fileRelativePaths).toEqual(["inside.txt"]);

    const outside = await processSandbox.run(
      `printf no > /tmp/models-kindergarten-outside-${Date.now()}.txt`,
      ".",
      5_000,
      signal,
    );
    expect(outside.exitCode).not.toBe(0);
    expect(outside.stderr).toContain("operation not permitted");
  });

  it("web_fetch 在发起请求前拒绝私有网络", async () => {
    await expect(new WebAccess().fetch(
      "http://127.0.0.1:11434/api/tags",
      new AbortController().signal,
    )).rejects.toThrow("私有网络");
  });

  it("web_fetch 响应过大时返回真实的资源限制错误", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("oversized", {
      headers: { "content-length": String(PRODUCT_CONFIG.tools.web.maxFetchBytes + 1) },
    })));

    await expect(new WebAccess().fetch(
      "https://8.8.8.8/resource",
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: "web_response_too_large",
      category: "resource_limit",
      message: `网页响应超过 ${PRODUCT_CONFIG.tools.web.maxFetchBytes} 字节资源上限`,
      retryable: false,
    });
  });

  it("Provider 失败在 Runner 边界转换成保留原因的 RunFailure", async () => {
    const sandbox = await makeSandbox();
    const runtime = AgentRuntime.fromRegistry(new FailedProvider(), new ToolRegistry(sandbox));
    await expect(runtime.run(
      { text: "你好", sessionEntries: [] },
      new TestObserver(true),
      new AbortController().signal,
    )).rejects.toMatchObject({ name: "RunFailure", message: "Ollama 不可用" });
  });

  it("系统提示明确每轮必须返回工具调用或非空最终正文", async () => {
    const sandbox = await makeSandbox();
    const provider = new CapturingReasoningProvider();
    const runtime = AgentRuntime.fromRegistry(provider, new ToolRegistry(sandbox));

    await runtime.run(
      { text: "说明输出要求", sessionEntries: [] },
      new TestObserver(true),
      new AbortController().signal,
    );

    expect(provider.lastInput?.systemPrompt).not.toContain("test");
    expect(provider.lastInput?.systemPrompt).toContain("工具调用");
    expect(provider.lastInput?.systemPrompt).toContain("非空的最终正文");
    expect(provider.lastInput?.systemPrompt).toContain("thinking");
    expect(provider.lastInput?.systemPrompt).toContain("【Skill 使用协议】");
    expect(provider.lastInput?.systemPrompt).toContain("当前 JSON Schema");
  });

  it("thinking-only 直接失败且不发起额外模型请求", async () => {
    const sandbox = await makeSandbox();
    const provider = new ScriptedResponseProvider([
      [
        { type: "thinking_delta", text: "我还应该继续处理" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const runtime = AgentRuntime.fromRegistry(provider, new ToolRegistry(sandbox));

    await expect(runtime.run(
      { text: "完成任务", sessionEntries: [] },
      new TestObserver(true),
      new AbortController().signal,
    )).rejects.toMatchObject({
      name: "RunFailure",
      code: "EMPTY_ASSISTANT_RESPONSE",
      retryable: true,
      message: expect.stringContaining("只有思考过程"),
    });
    expect(provider.inputs).toHaveLength(1);
  });

  it("完全空响应直接失败且不发起额外模型请求", async () => {
    const sandbox = await makeSandbox();
    const provider = new ScriptedResponseProvider([
      [{ type: "finish", reason: "stop" }],
    ]);
    const runtime = AgentRuntime.fromRegistry(provider, new ToolRegistry(sandbox));

    await expect(runtime.run(
      { text: "完成任务", sessionEntries: [] },
      new TestObserver(true),
      new AbortController().signal,
    )).rejects.toMatchObject({
      name: "RunFailure",
      code: "EMPTY_ASSISTANT_RESPONSE",
      retryable: true,
      message: expect.stringContaining("没有返回工具调用或最终正文"),
    });
    expect(provider.inputs).toHaveLength(1);
  });

  it("被截断的正文不能被误判为完成", async () => {
    const sandbox = await makeSandbox();
    const provider = new ScriptedResponseProvider([
      [
        { type: "text_delta", text: "尚未写完的回答" },
        { type: "finish", reason: "length" },
      ],
    ]);
    const runtime = AgentRuntime.fromRegistry(provider, new ToolRegistry(sandbox));

    await expect(runtime.run(
      { text: "完成任务", sessionEntries: [] },
      new TestObserver(true),
      new AbortController().signal,
    )).rejects.toMatchObject({
      name: "RunFailure",
      code: "MODEL_OUTPUT_TRUNCATED",
      retryable: true,
    });
    expect(provider.inputs).toHaveLength(1);
  });

  it("非空拒绝正文仍是可展示的正常最终答复", async () => {
    const sandbox = await makeSandbox();
    const provider = new ScriptedResponseProvider([
      [
        { type: "text_delta", text: "抱歉，我不能协助完成这个请求。" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const observer = new TestObserver(true);
    const runtime = AgentRuntime.fromRegistry(provider, new ToolRegistry(sandbox));

    const result = await runtime.run(
      { text: "完成任务", sessionEntries: [] },
      observer,
      new AbortController().signal,
    );

    expect(result.reason).toBe("stop");
    expect(observer.textOutput).toBe("抱歉，我不能协助完成这个请求。");
    expect(provider.inputs).toHaveLength(1);
  });

  it("没有 Agent resolver 时按 auto 跟随 ModelStudent 能力默认值", async () => {
    const sandbox = await makeSandbox();
    const provider = new CapturingReasoningProvider();
    const runtime = AgentRuntime.fromRegistry(provider, new ToolRegistry(sandbox));
    await runtime.run(
      { text: "使用默认思考强度", sessionEntries: [] },
      new TestObserver(true),
      new AbortController().signal,
    );
    expect(provider.lastInput?.reasoning).toMatchObject({
      requestedProfile: "auto",
      resolvedProfile: "deep",
      source: "model_default",
      native: { effort: "high" },
    });
  });

  it("Provider cancelled 后丢弃已累积 Tool Call，不产生任何工具副作用", async () => {
    const sandbox = await makeSandbox();
    const observer = new TestObserver(true);
    const runtime = AgentRuntime.fromRegistry(new CancelledToolProvider(), new ToolRegistry(sandbox));
    const result = await runtime.run(
      { text: "不要在取消后写文件", sessionEntries: [] },
      observer,
      new AbortController().signal,
    );

    expect(result.reason).toBe("cancelled");
    expect(observer.toolStartCount).toBe(0);
    expect(observer.permissionCount).toBe(0);
    expect(observer.outcomes).toHaveLength(0);
    await expect(readFile(join(sandbox.root, "cancelled.txt"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("小模型跨三个模型轮提交字段顺序不同但同值的错误参数后结束 Turn", async () => {
    const sandbox = await makeSandbox();
    const observer = new TestObserver(true);
    const runner = new AgentRunner(
      new InvalidArgumentsProvider("small"),
      new ToolRuntime(new ToolRegistry(sandbox)),
      new ContextAssembler(),
      noopRuntimeObservationSink,
      undefined,
      createSmallModelRepeatedInvalidToolCallGuard,
    );

    await expect(runner.run(
      { text: "读取文件", sessionEntries: [] },
      observer,
      new AbortController().signal,
    )).rejects.toMatchObject({
      name: "RunFailure",
      code: "TOOL_ARGUMENT_RETRY_LIMIT",
      retryable: false,
    });
    expect(observer.outcomes).toHaveLength(3);
    expect(observer.outcomes.every((item) => item.error?.code === "invalid_arguments")).toBe(true);
  });

  it("大模型收到相同参数错误提示但不启用重复调用终止节点", async () => {
    const sandbox = await makeSandbox();
    const observer = new TestObserver(true);
    const runner = new AgentRunner(
      new InvalidArgumentsProvider("large", 3),
      new ToolRuntime(new ToolRegistry(sandbox)),
      new ContextAssembler(),
      noopRuntimeObservationSink,
      undefined,
      createSmallModelRepeatedInvalidToolCallGuard,
    );

    const result = await runner.run(
      { text: "读取文件", sessionEntries: [] },
      observer,
      new AbortController().signal,
    );

    expect(result.reason).toBe("stop");
    expect(result.usage.modelRequests).toBe(4);
    expect(observer.outcomes).toHaveLength(3);
    expect(observer.outcomes.every((item) => item.error?.code === "invalid_arguments")).toBe(true);
    expect(observer.textOutput).toContain("已停止尝试错误参数");
  });
});

class InvalidArgumentsProvider implements ModelProvider {
  readonly student: ModelStudent;
  private round = 0;

  constructor(
    sizeClass: "small" | "large",
    private readonly invalidRounds = Number.POSITIVE_INFINITY,
  ) {
    this.student = {
      id: "invalid-arguments",
      name: "Invalid Arguments",
      sizeClass,
      provider: { kind: "ollama", model: "fixture", baseUrl: "http://127.0.0.1" },
      generationDefaults: {},
    };
  }

  serializeContext(fragment: ModelContextFragment): ModelContextSerialization {
    return serializeTestContext(this.student, fragment);
  }

  async *stream(): AsyncIterable<ModelEvent> {
    this.round += 1;
    if (this.round > this.invalidRounds) {
      yield { type: "text_delta", text: "已停止尝试错误参数" };
      yield { type: "finish", reason: "stop" };
      return;
    }
    yield {
      type: "tool_calls",
      calls: [{
        name: "read_file",
        arguments: this.round === 1
          ? { fileName: "a.txt", extra: true }
          : { extra: true, fileName: "a.txt" },
      }],
    };
    yield { type: "finish", reason: "stop" };
  }
}

class CancelledToolProvider implements ModelProvider {
  readonly student: ModelStudent = {
    id: "cancelled-tool",
    name: "Cancelled Tool",
    sizeClass: "large",
    provider: { kind: "ollama", model: "fixture", baseUrl: "http://127.0.0.1" },
    generationDefaults: {},
  };
  serializeContext(fragment: ModelContextFragment): ModelContextSerialization {
    return serializeTestContext(this.student, fragment);
  }
  async *stream(): AsyncIterable<ModelEvent> {
    yield {
      type: "tool_calls",
      calls: [{
        id: "cancelled-write",
        index: 0,
        name: "write_file",
        arguments: { path: "cancelled.txt", content: "不应写入" },
      }],
    };
    yield { type: "finish", reason: "cancelled" };
  }
}

class CapturingReasoningProvider implements ModelProvider {
  readonly student: ModelStudent = {
    id: "reasoning-default",
    name: "Reasoning Default",
    sizeClass: "large",
    provider: { kind: "openai-compatible", model: "fixture", baseUrl: "http://127.0.0.1" },
    generationDefaults: {},
  };
  readonly reasoningCapability: import("@kindergarten/contracts").ModelReasoningCapability = {
    schemaVersion: 1,
    control: "effort_levels",
    adjustable: true,
    supportedProfiles: ["balanced", "deep"],
    defaultProfile: "deep",
  };
  lastInput?: ModelInput;
  nativeReasoning(profile: "balanced" | "deep") {
    return { effort: profile === "deep" ? "high" : "medium" };
  }
  serializeContext(fragment: ModelContextFragment): ModelContextSerialization {
    return serializeTestContext(this.student, fragment);
  }
  async *stream(input: ModelInput): AsyncIterable<ModelEvent> {
    this.lastInput = structuredClone(input);
    yield { type: "text_delta", text: "已完成" };
    yield { type: "finish", reason: "stop" };
  }
}

class ScriptedResponseProvider implements ModelProvider {
  readonly student: ModelStudent = {
    id: "scripted-response",
    name: "Scripted Response",
    sizeClass: "large",
    provider: { kind: "ollama", model: "fixture", baseUrl: "http://127.0.0.1" },
    generationDefaults: {},
  };
  readonly inputs: ModelInput[] = [];

  constructor(private readonly rounds: ModelEvent[][]) {}

  serializeContext(fragment: ModelContextFragment): ModelContextSerialization {
    return serializeTestContext(this.student, fragment);
  }

  async *stream(input: ModelInput): AsyncIterable<ModelEvent> {
    this.inputs.push(structuredClone(input));
    const events = this.rounds[this.inputs.length - 1] ?? [];
    for (const event of events) yield structuredClone(event);
  }
}

class FailedProvider implements ModelProvider {
  readonly student: ModelStudent = {
    id: "failed",
    name: "Failed",
    sizeClass: "large",
    provider: { kind: "ollama", model: "fixture", baseUrl: "http://127.0.0.1" },
    generationDefaults: {},
  };
  serializeContext(fragment: ModelContextFragment): ModelContextSerialization {
    return serializeTestContext(this.student, fragment);
  }
  async *stream(): AsyncIterable<ModelEvent> {
    throw new ModelProviderError("dependency_unavailable", "Ollama 不可用", true);
  }
}

class RepeatingProvider implements ModelProvider {
  readonly student: ModelStudent = {
    id: "repeat",
    name: "Repeat",
    sizeClass: "large",
    provider: { kind: "ollama", model: "fixture", baseUrl: "http://127.0.0.1" },
    generationDefaults: {},
  };

  serializeContext(fragment: ModelContextFragment): ModelContextSerialization {
    return serializeTestContext(this.student, fragment);
  }

  constructor(
    private readonly name: string,
    private readonly argumentsValue: Record<string, unknown>,
  ) {}

  private rounds = 0;

  async *stream(_input: ModelInput): AsyncIterable<ModelEvent> {
    this.rounds += 1;
    if (this.rounds > 3) {
      yield { type: "text_delta", text: "模型已完成重复调用" };
      yield { type: "usage", inputTokens: 100 + this.rounds, outputTokens: 10 };
      yield { type: "finish", reason: "stop" };
      return;
    }
    yield {
      type: "tool_calls",
      calls: [{ name: this.name, arguments: this.argumentsValue }],
    };
    yield { type: "usage", inputTokens: 100 + this.rounds, outputTokens: 10 };
    yield { type: "finish", reason: "stop" };
  }
}

function serializeTestContext(
  student: ModelStudent,
  fragment: ModelContextFragment,
): ModelContextSerialization {
  const value = fragment.kind === "system"
    ? { role: "system", content: fragment.content }
    : fragment.kind === "tools"
      ? fragment.tools
      : fragment.kind === "messages"
        ? fragment.messages
        : { sent: false, sourceIds: fragment.sourceIds };
  return {
    provider: student.provider.kind,
    model: student.provider.model,
    format: "json",
    value: JSON.stringify(value, null, 2),
  };
}

class TestObserver implements RunObserver {
  outcomes: ToolOutcome[] = [];
  contextSummaries: ContextSummary[] = [];
  textOutput = "";
  permissionCount = 0;
  toolStartCount = 0;

  constructor(private readonly permission: boolean) {}
  async context(summary: ContextSummary): Promise<void> { this.contextSummaries.push(summary); }
  async text(_round: number, value: string): Promise<void> { this.textOutput += value; }
  async thought(): Promise<void> {}
  async roundComplete(): Promise<void> {}
  async toolStart(_call: PreparedToolCall): Promise<void> { this.toolStartCount += 1; }
  async toolFinish(_call: PreparedToolCall, _status: "pending" | "in_progress" | "completed" | "failed", outcome: ToolOutcome): Promise<void> {
    this.outcomes.push(outcome);
  }
  async requestPermission(): Promise<boolean> {
    this.permissionCount += 1;
    return this.permission;
  }
  async askUser(): Promise<string> { return "answer"; }
}

async function makeSandbox(): Promise<FileSandbox> {
  const root = await mkdtemp(join(tmpdir(), "kindergarten-v15-"));
  dirs.push(root);
  const sandbox = new FileSandbox(root);
  await sandbox.initialize();
  return sandbox;
}

function message(role: "user" | "assistant", text: string, messageId: string): SessionEntry {
  return {
    type: "message",
    role,
    text,
    turnId: "t1",
    messageId,
    createdAt: new Date().toISOString(),
  };
}
