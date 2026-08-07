import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextBuilder } from "../src/conversation/context-builder.js";
import type {
  ModelEvent,
  ModelInput,
  ModelProvider,
  ModelStudent,
} from "../src/model/model-provider.js";
import type { SessionEntry } from "../src/repository/session-types.js";
import { AgentRuntime, type RunObserver } from "../src/runtime/agent-runtime.js";
import { ModelProviderError } from "../src/model/model-error.js";
import { ProcessSandbox } from "../src/tools/process-sandbox.js";
import { FileSandbox } from "../src/tools/sandbox.js";
import type { PreparedToolCall, ToolOutcome } from "../src/tools/tool-registry.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { WebAccess } from "../src/tools/web-access.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("V1.5 Agent Runtime", () => {
  it("成功工具被重复提议时只执行一次，并把缓存结果继续交给模型", async () => {
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
    expect(observer.permissionCount).toBe(1);
    expect(observer.outcomes.map((item) => item.status)).toEqual([
      "success",
      "duplicate_blocked",
      "duplicate_blocked",
    ]);
    expect(await readFile(join(sandbox.root, "repeat.txt"), "utf8")).toBe("只写一次");
    expect(observer.textOutput).toContain("模型已读取去重结果");
  });

  it("权限拒绝后相同命令不会再次询问或执行", async () => {
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
    expect(observer.permissionCount).toBe(1);
    expect(observer.outcomes.map((item) => item.status)).toEqual([
      "denied",
      "duplicate_blocked",
      "duplicate_blocked",
    ]);
    await expect(readFile(join(sandbox.root, "denied.txt"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("同一 SessionEntry 源分别投影历史工具结果和当前用户消息", () => {
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
    const modelMessages = new ContextBuilder().build(entries, "继续");
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

  it.runIf(process.platform === "darwin")("终端允许沙箱内写入并拒绝沙箱外写入", async () => {
    const sandbox = await makeSandbox();
    const processSandbox = new ProcessSandbox(sandbox);
    const signal = new AbortController().signal;
    const inside = await processSandbox.run("printf ok > inside.txt", ".", 5_000, signal);
    expect(inside.exitCode).toBe(0);
    expect(await readFile(join(sandbox.root, "inside.txt"), "utf8")).toBe("ok");

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

  it("Provider 失败在 Runner 边界转换成保留原因的 RunFailure", async () => {
    const sandbox = await makeSandbox();
    const runtime = AgentRuntime.fromRegistry(new FailedProvider(), new ToolRegistry(sandbox));
    await expect(runtime.run(
      { text: "你好", sessionEntries: [] },
      new TestObserver(true),
      new AbortController().signal,
    )).rejects.toMatchObject({ name: "RunFailure", message: "Ollama 不可用" });
  });
});

class FailedProvider implements ModelProvider {
  readonly student: ModelStudent = {
    id: "failed",
    name: "Failed",
    provider: { kind: "ollama", model: "fixture", baseUrl: "http://127.0.0.1" },
    agentConfig: { systemPrompt: "test" },
  };
  async *stream(): AsyncIterable<ModelEvent> {
    throw new ModelProviderError("dependency_unavailable", "Ollama 不可用", true);
  }
}

class RepeatingProvider implements ModelProvider {
  readonly student: ModelStudent = {
    id: "repeat",
    name: "Repeat",
    provider: { kind: "ollama", model: "fixture", baseUrl: "http://127.0.0.1" },
    agentConfig: { systemPrompt: "test" },
  };

  constructor(
    private readonly name: string,
    private readonly argumentsValue: Record<string, unknown>,
  ) {}

  private rounds = 0;

  async *stream(_input: ModelInput): AsyncIterable<ModelEvent> {
    this.rounds += 1;
    if (this.rounds > 3) {
      yield { type: "text_delta", text: "模型已读取去重结果" };
      yield { type: "finish", reason: "stop" };
      return;
    }
    yield {
      type: "tool_calls",
      calls: [{ name: this.name, arguments: this.argumentsValue }],
    };
    yield { type: "finish", reason: "stop" };
  }
}

class TestObserver implements RunObserver {
  outcomes: ToolOutcome[] = [];
  textOutput = "";
  permissionCount = 0;

  constructor(private readonly permission: boolean) {}
  async text(_round: number, value: string): Promise<void> { this.textOutput += value; }
  async thought(): Promise<void> {}
  async roundComplete(): Promise<void> {}
  async toolStart(_call: PreparedToolCall): Promise<void> {}
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
