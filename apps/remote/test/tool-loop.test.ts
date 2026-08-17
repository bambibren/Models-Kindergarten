import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { TURN_STATE_NOTIFICATION, makePromptMeta, makeSessionBindingMeta, readTurnStateNotification, type TurnState } from "@kindergarten/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KindergartenAgent } from "../src/acp/kindergarten-agent.js";
import type {
  ModelContextFragment,
  ModelContextSerialization,
  ModelEvent,
  ModelInput,
  ModelProvider,
  ModelStudent,
} from "../src/model/model-provider.js";
import { SessionRepository } from "../src/repository/session-repository.js";
import type { SessionToolCallEntry } from "../src/repository/session-types.js";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { FileSandbox } from "../src/tools/sandbox.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { ToolCallLedger, ToolRuntime, type ToolObserver } from "../src/tools/tool-runtime.js";
import { SessionBindingService } from "../src/session/session-binding-service.js";
import type { FileReferenceService } from "../src/files/file-reference-service.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("Tool Loop", () => {
  it("写入授权、AskUser、读取和历史回放形成完整 ACP 闭环", async () => {
    const dir = await tempDir();
    const sandbox = new FileSandbox(join(dir, "sandbox"));
    await sandbox.initialize();
    const sessions = new SessionRepository(join(dir, "data"));
    const agent = new KindergartenAgent(
      sessions,
      AgentRuntime.fromRegistry(new ScriptedToolProvider(), new ToolRegistry(sandbox)),
      testBindings(),
    ).createApp();

    const updates: acp.SessionNotification[] = [];
    const permissions: acp.RequestPermissionRequest[] = [];
    const questions: acp.CreateElicitationRequest[] = [];
    const turnStates: TurnState[] = [];
    const clientApp = acp
      .client({ name: "tool-test-client" })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        updates.push(params);
      })
      .onNotification(TURN_STATE_NOTIFICATION, { parse: readTurnStateNotification }, ({ params }) => {
        turnStates.push(params.turn);
      })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
        permissions.push(params);
        return { outcome: { outcome: "selected", optionId: "allow-once" } };
      })
      .onRequest(acp.methods.client.elicitation.create, ({ params }) => {
        questions.push(params);
        return { action: "accept", content: { answer: "蓝色" } };
      });
    const client = clientApp.connect(agent);
    await client.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { elicitation: { form: {} } },
    });
    const session = await client.agent.request(acp.methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
      _meta: makeSessionBindingMeta({ schemaVersion: 1, modelStudentId: "student-1", agentId: "agent-1" }),
    });

    const response = await client.agent.request(acp.methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "完成工具测试" }],
      _meta: makePromptMeta({ schemaVersion: 1, turnId: "tool-turn" }),
    });

    expect(response.stopReason).toBe("end_turn");
    expect(permissions).toHaveLength(1);
    expect(questions).toHaveLength(1);
    expect(await readFile(join(dir, "sandbox", "notes", "answer.txt"), "utf8"))
      .toBe("初始内容");

    const starts = updates.flatMap((notice) =>
      notice.update.sessionUpdate === "tool_call" ? [notice.update] : [],
    );
    expect(starts.map((item) => item.name)).toEqual([
      "write_file",
      "ask_user",
      "read_file",
    ]);
    expect(updates.filter((notice) =>
      notice.update.sessionUpdate === "tool_call_update" &&
      notice.update.status === "completed",
    )).toHaveLength(3);
    expect(turnStates).toContainEqual(expect.objectContaining({ status: "active", phase: "preparing_context" }));
    expect(turnStates).toContainEqual(expect.objectContaining({ status: "active", phase: "model_streaming" }));
    expect(turnStates).toContainEqual(expect.objectContaining({ status: "active", phase: "tool_execution" }));
    expect(turnStates.at(-1)).toEqual({ schemaVersion: 1, turnId: "tool-turn", status: "completed" });
    expect((await sessions.get(session.sessionId)).turns[0]).toMatchObject({
      state: { status: "completed" },
      stopReason: "end_turn",
    });

    updates.length = 0;
    await client.agent.request(acp.methods.agent.session.load, {
      sessionId: session.sessionId,
      cwd: "/workspace",
      mcpServers: [],
    });
    const replayedTools = updates.flatMap((notice) =>
      notice.update.sessionUpdate === "tool_call" ? [notice.update] : [],
    );
    expect(replayedTools).toHaveLength(3);
    expect(replayedTools.every((item) => item.status === "completed")).toBe(true);

    client.close();
    await client.closed;
  });

  it("拒绝绝对路径和父目录穿越", async () => {
    const dir = await tempDir();
    const sandbox = new FileSandbox(join(dir, "sandbox"));
    await sandbox.initialize();
    await expect(sandbox.readText("../secret.txt")).rejects.toThrow("path");
    await expect(sandbox.writeText("/tmp/escape.txt", "no"))
      .rejects.toThrow("相对");
  });

  it("授权请求悬挂后由新页面 load 恢复活动状态，并把请求重发到新 ACP client", async () => {
    const dir = await tempDir();
    const sandbox = new FileSandbox(join(dir, "sandbox"));
    await sandbox.initialize();
    const sessions = new SessionRepository(join(dir, "data"));
    const agent = new KindergartenAgent(
      sessions,
      AgentRuntime.fromRegistry(new ScriptedToolProvider(), new ToolRegistry(sandbox)),
      testBindings(),
    ).createApp();

    const firstPermissions: acp.RequestPermissionRequest[] = [];
    const firstApp = acp
      .client({ name: "first-page" })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
        firstPermissions.push(params);
        return new Promise<acp.RequestPermissionResponse>(() => undefined);
      })
      .onRequest(acp.methods.client.elicitation.create, () => ({ action: "accept", content: { answer: "蓝色" } }));
    const first = firstApp.connect(agent);
    await initialize(first);
    const session = await first.agent.request(acp.methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
      _meta: makeSessionBindingMeta({ schemaVersion: 1, modelStudentId: "student-1", agentId: "agent-1" }),
    });
    const abandonedPrompt = first.agent.request(acp.methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "恢复授权" }],
      _meta: makePromptMeta({ schemaVersion: 1, turnId: "resume-permission-turn" }),
    }).catch(() => undefined);

    await vi.waitFor(() => expect(firstPermissions).toHaveLength(1));
    await vi.waitFor(async () => {
      expect((await sessions.get(session.sessionId)).turns[0]?.state).toMatchObject({
        status: "active",
        phase: "tool_execution",
        waitingFor: { permission: 1, input: 0 },
        pendingInteractions: [{
          interactionId: "permission:ollama-write",
          kind: "permission",
          toolCall: { toolCallId: "ollama-write", name: "write_file" },
        }],
      });
    });
    first.close();
    await first.closed;

    const restoredStates: TurnState[] = [];
    const secondPermissions: acp.RequestPermissionRequest[] = [];
    const secondApp = acp
      .client({ name: "restored-page" })
      .onNotification(TURN_STATE_NOTIFICATION, { parse: readTurnStateNotification }, ({ params }) => {
        restoredStates.push(params.turn);
      })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
        secondPermissions.push(params);
        return { outcome: { outcome: "selected", optionId: "allow-once" } };
      })
      .onRequest(acp.methods.client.elicitation.create, () => ({ action: "accept", content: { answer: "蓝色" } }));
    const second = secondApp.connect(agent);
    await initialize(second);
    await second.agent.request(acp.methods.agent.session.load, {
      sessionId: session.sessionId,
      cwd: "/workspace",
      mcpServers: [],
    });

    await vi.waitFor(async () => {
      expect((await sessions.get(session.sessionId)).turns[0]?.state).toMatchObject({ status: "completed" });
    });
    expect(restoredStates).toContainEqual(expect.objectContaining({
      status: "active",
      phase: "tool_execution",
      waitingFor: { permission: 1, input: 0 },
      pendingInteractions: [expect.objectContaining({ interactionId: "permission:ollama-write" })],
    }));
    expect(secondPermissions).toHaveLength(1);
    expect(await readFile(join(dir, "sandbox", "notes", "answer.txt"), "utf8")).toBe("初始内容");

    await abandonedPrompt;
    second.close();
    await second.closed;
  });

  it("授权被拒绝时不调用 FileSandbox 写入，也不产生目标文件", async () => {
    const dir = await tempDir();
    const sandbox = new FileSandbox(join(dir, "sandbox"));
    await sandbox.initialize();
    const registry = new ToolRegistry(sandbox);
    const runtime = new ToolRuntime(registry);
    const call = registry.prepare({
      id: "rejected-write",
      name: "write_file",
      arguments: { path: "denied/result.html", content: "should-not-exist" },
    }, "fallback");
    const observer: ToolObserver = {
      toolStart: async () => undefined,
      toolFinish: async () => undefined,
      requestPermission: async () => false,
      askUser: async () => "",
    };

    const result = await runtime.executeBatch(
      [call],
      observer,
      new ToolCallLedger(),
      new AbortController().signal,
    );

    expect(result.outcomes[0]).toMatchObject({ status: "denied", error: { code: "permission_denied" } });
    await expect(access(join(dir, "sandbox", "denied", "result.html"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("文件工具完成后在 Turn 继续生成期间立即发布预览引用", async () => {
    const dir = await tempDir();
    const sandbox = new FileSandbox(join(dir, "sandbox"));
    await sandbox.initialize();
    const sessions = new SessionRepository(join(dir, "data"));
    const provider = new WriteThenWaitProvider();
    const createFromPaths = vi.fn(async (_ownerId: string, sessionId: string, turnId: string) => [{
      schemaVersion: 1 as const,
      fileReferenceId: "file_streamed1234567890abcdef1234567890",
      ownerId: "local-admin",
      sessionId,
      turnId,
      displayName: "index.html",
      relativePath: "index.html",
      mimeType: "text/html",
      byteLength: 15,
      sha256: "a".repeat(64),
      previewKind: "static_html" as const,
      createdAt: "2026-08-17T00:00:00.000Z",
    }]);
    const files = { createFromPaths } as unknown as FileReferenceService;
    const agent = new KindergartenAgent(
      sessions,
      AgentRuntime.fromRegistry(provider, new ToolRegistry(sandbox)),
      testBindings(),
      files,
    ).createApp();
    const updates: acp.SessionNotification[] = [];
    const client = acp.client({ name: "streamed-artifact-page" })
      .onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(params); })
      .onRequest(acp.methods.client.session.requestPermission, () => ({
        outcome: { outcome: "selected", optionId: "allow-once" },
      }))
      .connect(agent);
    await initialize(client);
    const session = await client.agent.request(acp.methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
      _meta: makeSessionBindingMeta({ schemaVersion: 1, modelStudentId: "student-1", agentId: "agent-1" }),
    });

    const prompt = client.agent.request(acp.methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "写完文件后继续回答" }],
      _meta: makePromptMeta({ schemaVersion: 1, turnId: "streamed-artifact-turn" }),
    });
    await provider.waitForSecondRound();

    await vi.waitFor(() => expect(updates.some((notice) => {
      const update = notice.update;
      return update.sessionUpdate === "tool_call_update" && update.content?.some((item) =>
        item.type === "content" && item.content.type === "resource_link" &&
        item.content.uri === "mk-file://file_streamed1234567890abcdef1234567890");
    })).toBe(true));
    expect(createFromPaths).toHaveBeenCalledTimes(1);

    provider.continueSecondRound();
    await prompt;
    client.close();
    await client.closed;
  });

  it.runIf(process.platform === "darwin")("终端真实改写文件后同样立即发布预览引用", async () => {
    const dir = await tempDir();
    const sandbox = new FileSandbox(join(dir, "sandbox"));
    await sandbox.initialize();
    await sandbox.writeText("index.html", "<h1>旧版本</h1>");
    const sessions = new SessionRepository(join(dir, "data"));
    const provider = new CommandThenWaitProvider();
    const createFromPaths = vi.fn(async (_ownerId: string, sessionId: string, turnId: string) => [{
      schemaVersion: 1 as const,
      fileReferenceId: "file_command1234567890abcdef123456789",
      ownerId: "local-admin",
      sessionId,
      turnId,
      displayName: "index.html",
      relativePath: "index.html",
      mimeType: "text/html",
      byteLength: 18,
      sha256: "b".repeat(64),
      previewKind: "static_html" as const,
      createdAt: "2026-08-17T00:00:00.000Z",
    }]);
    const files = { createFromPaths } as unknown as FileReferenceService;
    const agent = new KindergartenAgent(
      sessions,
      AgentRuntime.fromRegistry(provider, new ToolRegistry(sandbox)),
      testBindings(),
      files,
    ).createApp();
    const updates: acp.SessionNotification[] = [];
    const client = acp.client({ name: "command-artifact-page" })
      .onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(params); })
      .onRequest(acp.methods.client.session.requestPermission, () => ({
        outcome: { outcome: "selected", optionId: "allow-once" },
      }))
      .connect(agent);
    await initialize(client);
    const session = await client.agent.request(acp.methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
      _meta: makeSessionBindingMeta({ schemaVersion: 1, modelStudentId: "student-1", agentId: "agent-1" }),
    });

    const prompt = client.agent.request(acp.methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "用命令修改文件" }],
      _meta: makePromptMeta({ schemaVersion: 1, turnId: "command-artifact-turn" }),
    });
    await provider.waitForSecondRound();

    expect(createFromPaths).toHaveBeenCalledWith(
      "local-admin",
      session.sessionId,
      "command-artifact-turn",
      ["index.html"],
    );
    expect(updates.some((notice) => {
      const update = notice.update;
      return update.sessionUpdate === "tool_call_update" && update.toolCallId === "streamed-command" &&
        update.content?.some((item) => item.type === "content" && item.content.type === "resource_link");
    })).toBe(true);

    provider.continueSecondRound();
    await prompt;
    client.close();
    await client.closed;
  });

  it("文件写入成功后，即使 Turn 后续失败也保留预览引用", async () => {
    const dir = await tempDir();
    const sandbox = new FileSandbox(join(dir, "sandbox"));
    await sandbox.initialize();
    const sessions = new SessionRepository(join(dir, "data"));
    const createFromPaths = vi.fn(async (_ownerId: string, sessionId: string, turnId: string) => [{
      schemaVersion: 1 as const,
      fileReferenceId: "file_1234567890abcdef1234567890abcdef",
      ownerId: "local-admin",
      sessionId,
      turnId,
      displayName: "index.html",
      relativePath: "index.html",
      mimeType: "text/html",
      byteLength: 15,
      sha256: "a".repeat(64),
      previewKind: "static_html" as const,
      createdAt: "2026-08-17T00:00:00.000Z",
    }]);
    const files = { createFromPaths } as unknown as FileReferenceService;
    const agent = new KindergartenAgent(
      sessions,
      AgentRuntime.fromRegistry(new WriteThenFailProvider(), new ToolRegistry(sandbox)),
      testBindings(),
      files,
    ).createApp();
    const client = acp.client({ name: "failed-artifact-page" })
      .onRequest(acp.methods.client.session.requestPermission, () => ({
        outcome: { outcome: "selected", optionId: "allow-once" },
      }))
      .connect(agent);
    await initialize(client);
    const session = await client.agent.request(acp.methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
      _meta: makeSessionBindingMeta({ schemaVersion: 1, modelStudentId: "student-1", agentId: "agent-1" }),
    });

    await expect(client.agent.request(acp.methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "先写文件，再模拟模型失败" }],
      _meta: makePromptMeta({ schemaVersion: 1, turnId: "failed-artifact-turn" }),
    })).rejects.toThrow();

    const stored = await sessions.get(session.sessionId);
    expect(stored.turns[0]).toMatchObject({
      state: { status: "failed" },
      fileReferenceIds: ["file_1234567890abcdef1234567890abcdef"],
    });
    const write = stored.sessionEntries.find((entry): entry is SessionToolCallEntry =>
      entry.type === "tool_call" && entry.name === "write_file");
    expect(write?.content).toContainEqual(expect.objectContaining({
      type: "content",
      content: expect.objectContaining({
        type: "resource_link",
        uri: "mk-file://file_1234567890abcdef1234567890abcdef",
      }),
    }));
    expect(createFromPaths).toHaveBeenCalledWith(
      "local-admin",
      session.sessionId,
      "failed-artifact-turn",
      ["index.html"],
    );
    expect(await readFile(join(dir, "sandbox", "index.html"), "utf8")).toBe("<h1>完成</h1>");

    client.close();
    await client.closed;
  });

});

function testBindings(): SessionBindingService {
  return new SessionBindingService({
    workspaceCwd: "/workspace",
    agentExists: (id) => id === "agent-1",
    modelStudentReady: (id) => id === "student-1",
    experimentBinding: async () => undefined,
  });
}

class ScriptedToolProvider implements ModelProvider {
  readonly student: ModelStudent = {
    id: "tool-fixture",
    name: "Tool Fixture",
    sizeClass: "large",
    provider: { kind: "ollama", model: "fixture", baseUrl: "http://127.0.0.1" },
    generationDefaults: {},
  };
  serializeContext(fragment: ModelContextFragment): ModelContextSerialization {
    const value = fragment.kind === "system"
      ? { role: "system", content: fragment.content }
      : fragment.kind === "tools"
        ? fragment.tools
        : fragment.kind === "messages"
          ? fragment.messages
          : { sent: false, sourceIds: fragment.sourceIds };
    return {
      provider: this.student.provider.kind,
      model: this.student.provider.model,
      format: "json",
      value: JSON.stringify(value, null, 2),
    };
  }

  async *stream(input: ModelInput): AsyncIterable<ModelEvent> {
    const results = input.messages.filter((item) => item.role === "tool");
    if (results.length === 0) {
      yield {
        type: "tool_calls",
        calls: [
          {
            id: "ollama-write",
            name: "write_file",
            arguments: { path: "notes/answer.txt", content: "初始内容" },
          },
          {
            id: "ollama-ask",
            name: "ask_user",
            arguments: { question: "你喜欢什么颜色？" },
          },
        ],
      };
    } else if (results.length === 2) {
      yield {
        type: "tool_calls",
        calls: [{
          id: "ollama-read",
          name: "read_file",
          arguments: { path: "notes/answer.txt" },
        }],
      };
    } else {
      yield { type: "text_delta", text: "工具链已完成" };
    }
    yield { type: "finish", reason: "stop" };
  }
}

class WriteThenFailProvider extends ScriptedToolProvider {
  override async *stream(input: ModelInput): AsyncIterable<ModelEvent> {
    if (!input.messages.some((item) => item.role === "tool")) {
      yield {
        type: "tool_calls",
        calls: [{
          id: "write-before-failure",
          name: "write_file",
          arguments: { path: "index.html", content: "<h1>完成</h1>" },
        }],
      };
      yield { type: "finish", reason: "stop" };
      return;
    }
    throw new Error("模拟写入后的模型失败");
  }
}

class WriteThenWaitProvider extends ScriptedToolProvider {
  private secondRoundStarted!: () => void;
  private secondRoundContinued!: () => void;
  private readonly secondRound = new Promise<void>((resolve) => { this.secondRoundStarted = resolve; });
  private readonly continuation = new Promise<void>((resolve) => { this.secondRoundContinued = resolve; });

  waitForSecondRound(): Promise<void> { return this.secondRound; }
  continueSecondRound(): void { this.secondRoundContinued(); }

  override async *stream(input: ModelInput): AsyncIterable<ModelEvent> {
    if (!input.messages.some((item) => item.role === "tool")) {
      yield {
        type: "tool_calls",
        calls: [{
          id: "streamed-write",
          name: "write_file",
          arguments: { path: "index.html", content: "<h1>完成</h1>" },
        }],
      };
      yield { type: "finish", reason: "stop" };
      return;
    }
    this.secondRoundStarted();
    await this.continuation;
    yield { type: "text_delta", text: "文件已经完成" };
    yield { type: "finish", reason: "stop" };
  }
}

class CommandThenWaitProvider extends ScriptedToolProvider {
  private secondRoundStarted!: () => void;
  private secondRoundContinued!: () => void;
  private readonly secondRound = new Promise<void>((resolve) => { this.secondRoundStarted = resolve; });
  private readonly continuation = new Promise<void>((resolve) => { this.secondRoundContinued = resolve; });

  waitForSecondRound(): Promise<void> { return this.secondRound; }
  continueSecondRound(): void { this.secondRoundContinued(); }

  override async *stream(input: ModelInput): AsyncIterable<ModelEvent> {
    if (!input.messages.some((item) => item.role === "tool")) {
      yield {
        type: "tool_calls",
        calls: [{
          id: "streamed-command",
          name: "run_command",
          arguments: { command: "printf '<h1>新版本</h1>' > index.html; false" },
        }],
      };
      yield { type: "finish", reason: "stop" };
      return;
    }
    this.secondRoundStarted();
    await this.continuation;
    yield { type: "text_delta", text: "命令修改已完成" };
    yield { type: "finish", reason: "stop" };
  }
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kindergarten-tools-"));
  tempDirs.push(dir);
  return dir;
}

async function initialize(client: acp.ClientConnection): Promise<void> {
  await client.agent.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: { elicitation: { form: {} } },
  });
}
