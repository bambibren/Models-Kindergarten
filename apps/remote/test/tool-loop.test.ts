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

const tempDirs: string[] = [];

afterEach(/** 在每个测试后释放临时资源，保证后续场景从干净状态开始。 */
async () => {
  await Promise.all(
    tempDirs.splice(0).map(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("Tool Loop", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("写入授权、AskUser、读取和历史回放形成完整 ACP 闭环", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
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
      .onNotification(acp.methods.client.session.update, /** 构造「onNotification」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
({ params }) => {
        updates.push(params);
      })
      .onNotification(TURN_STATE_NOTIFICATION, { parse: readTurnStateNotification }, /** 构造「onRequest」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
({ params }) => {
        turnStates.push(params.turn);
      })
      .onRequest(acp.methods.client.session.requestPermission, /** 构造「onRequest」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
({ params }) => {
        permissions.push(params);
        return { outcome: { outcome: "selected", optionId: "allow-once" } };
      })
      .onRequest(acp.methods.client.elicitation.create, /** 构造「clientApp」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
({ params }) => {
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

    const starts = updates.flatMap(/** 构造「starts」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(notice) =>
      notice.update.sessionUpdate === "tool_call" ? [notice.update] : [],
    );
    expect(starts.map(/** 构造「toEqual」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(item) => item.name)).toEqual([
      "write_file",
      "ask_user",
      "read_file",
    ]);
    expect(updates.filter(/** 构造「toHaveLength」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(notice) =>
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
    const replayedTools = updates.flatMap(/** 构造「replayedTools」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(notice) =>
      notice.update.sessionUpdate === "tool_call" ? [notice.update] : [],
    );
    expect(replayedTools).toHaveLength(3);
    expect(replayedTools.every(/** 构造「toBe」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(item) => item.status === "completed")).toBe(true);

    client.close();
    await client.closed;
  });

  it("拒绝绝对路径和父目录穿越", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const dir = await tempDir();
    const sandbox = new FileSandbox(join(dir, "sandbox"));
    await sandbox.initialize();
    await expect(sandbox.readText("../secret.txt")).rejects.toThrow("path");
    await expect(sandbox.writeText("/tmp/escape.txt", "no"))
      .rejects.toThrow("相对");
  });

  it("按行替换相隔较远的多个片段且保留中间内容", /** 验证模型只需提交变化片段，不必重新输出两段之间的完整文件。 */
async () => {
    const dir = await tempDir();
    const sandbox = new FileSandbox(join(dir, "sandbox"));
    await sandbox.initialize();
    const before = "头部\n旧甲\n中间保持不变\n旧乙\n尾部";
    await sandbox.writeText("index.html", before);

    const result = await sandbox.editText("index.html", [
      { oldText: "旧甲", newText: "新甲" },
      { oldText: "旧乙", newText: "新乙" },
    ]);

    expect(result.replacements).toEqual([1, 1]);
    expect(result.oldText).toBe(before);
    expect((await sandbox.readText("index.html")).content)
      .toBe("头部\n新甲\n中间保持不变\n新乙\n尾部");
  });

  it("任一旧文本不是唯一匹配时整次按行替换不写入", /** 锁定全量预校验不变量，避免文件只修改一半。 */
async () => {
    const dir = await tempDir();
    const sandbox = new FileSandbox(join(dir, "sandbox"));
    await sandbox.initialize();
    const before = "唯一片段\n重复片段\n重复片段\n保持不变";
    await sandbox.writeText("index.html", before);

    await expect(sandbox.editText("index.html", [
      { oldText: "唯一片段", newText: "已经改动" },
      { oldText: "重复片段", newText: "不得写入" },
    ])).rejects.toThrow("实际匹配 2 次");
    expect((await sandbox.readText("index.html")).content).toBe(before);

    await expect(sandbox.editText("index.html", [
      { oldText: "不存在片段", newText: "不得写入" },
    ])).rejects.toThrow("实际匹配 0 次");
    expect((await sandbox.readText("index.html")).content).toBe(before);

    await expect(sandbox.editText("index.html", [
      { oldText: "", newText: "不得写入" },
    ])).rejects.toThrow("old_text 必须是非空字符串");
    expect((await sandbox.readText("index.html")).content).toBe(before);

    await expect(sandbox.editText("missing.html", [
      { oldText: "任意文本", newText: "不得创建文件" },
    ])).rejects.toThrow();
    await expect(access(join(dir, "sandbox", "missing.html"))).rejects.toThrow();
  });

  it("edit_file 共享 write_file 权限并返回标准 diff", /** 验证现有 Agent 不迁移配置也能获得受控增量编辑能力。 */
async () => {
    const dir = await tempDir();
    const sandbox = new FileSandbox(join(dir, "sandbox"));
    await sandbox.initialize();
    await sandbox.writeText("index.html", "课间汽水社\n旧标语");
    const registry = new ToolRegistry(sandbox, undefined, undefined, new Map([
      ["write_file", { enabled: true, permission: "allow" as const }],
    ]));

    expect(registry.definitions.map(/** 只读取公开 Tool 名称，确认派生能力与写入权限一起启用。 */
    (item) => item.function.name)).toEqual(["write_file", "edit_file"]);
    const call = registry.prepare({
      id: "edit-lines",
      name: "edit_file",
      arguments: {
        path: "index.html",
        edits: [{ old_text: "旧标语", new_text: "快来一起做汽水课间操！" }],
      },
    }, "fallback");
    expect(call).toMatchObject({ title: "按行替换 index.html", kind: "edit", permission: "allow" });

    const result = await registry.execute(call, {
      signal: new AbortController().signal,
      askUser: /** 当前工具不应进入 AskUser；若意外调用则让测试直接失败。 */ async () => {
        throw new Error("不应调用 AskUser");
      },
    });
    expect(result.rawOutput).toMatchObject({ replacements: [1] });
    expect(result.content[0]?.type).toBe("diff");
    expect((await sandbox.readText("index.html")).content)
      .toBe("课间汽水社\n快来一起做汽水课间操！");

    expect(() => registry.prepare({
      name: "edit_file",
      arguments: {
        path: "index.html",
        edits: [{ old_text: "课间汽水社", new_text: "汽水社", unexpected: true }],
      },
    }, "invalid-edit")).toThrow("包含未知字段");
  });

  it("授权请求悬挂后由新页面 load 恢复活动状态，并把请求重发到新 ACP client", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
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
      .onRequest(acp.methods.client.session.requestPermission, /** 构造「onRequest」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
({ params }) => {
        firstPermissions.push(params);
        return new Promise<acp.RequestPermissionResponse>(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
() => undefined);
      })
      .onRequest(acp.methods.client.elicitation.create, /** 构造「firstApp」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => ({ action: "accept", content: { answer: "蓝色" } }));
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
    }).catch(/** 构造「abandonedPrompt」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => undefined);

    await vi.waitFor(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
() => expect(firstPermissions).toHaveLength(1));
    await vi.waitFor(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
async () => {
      const state = (await sessions.get(session.sessionId)).turns[0]?.state;
      expect(state).toMatchObject({
        status: "active",
        phase: "tool_execution",
        waitingFor: { permission: 1 },
      });
      if (!state || state.status !== "active") throw new Error("等待中的 Permission 未形成活动 Turn 状态");
      expect(state.pendingInteractions).toContainEqual(expect.objectContaining({
          interactionId: "permission:ollama-write",
          kind: "permission",
          toolCall: expect.objectContaining({ toolCallId: "ollama-write", name: "write_file" }),
      }));
    });
    first.close();
    await first.closed;

    const restoredStates: TurnState[] = [];
    const secondPermissions: acp.RequestPermissionRequest[] = [];
    const secondApp = acp
      .client({ name: "restored-page" })
      .onNotification(TURN_STATE_NOTIFICATION, { parse: readTurnStateNotification }, /** 构造「onRequest」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
({ params }) => {
        restoredStates.push(params.turn);
      })
      .onRequest(acp.methods.client.session.requestPermission, /** 构造「onRequest」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
({ params }) => {
        secondPermissions.push(params);
        return { outcome: { outcome: "selected", optionId: "allow-once" } };
      })
      .onRequest(acp.methods.client.elicitation.create, /** 构造「secondApp」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => ({ action: "accept", content: { answer: "蓝色" } }));
    const second = secondApp.connect(agent);
    await initialize(second);
    await second.agent.request(acp.methods.agent.session.load, {
      sessionId: session.sessionId,
      cwd: "/workspace",
      mcpServers: [],
    });

    await vi.waitFor(/** 同时等待持久化终态和 ACP 终态投影，避免并发测试负载造成过早清理。 */
async () => {
      expect((await sessions.get(session.sessionId)).turns[0]?.state).toMatchObject({ status: "completed" });
      // 等待终态也完成 ACP 投影，避免测试清理目录时仍有异步终态写入。
      expect(restoredStates).toContainEqual(expect.objectContaining({ status: "completed" }));
    }, { timeout: 10_000 });
    // 同批 ask_user 可在 Permission 前后进入等待，恢复断言只依赖两者共享的协议不变量，不锁定并发先后。
    expect(restoredStates.some(/** 检查恢复投影曾包含待决 Permission，而不要求并行 Elicitation 尚未开始。 */
    (state) => state.status === "active" &&
      state.phase === "tool_execution" &&
      state.waitingFor.permission === 1 &&
      state.pendingInteractions.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
      (interaction) => interaction.interactionId === "permission:ollama-write"))).toBe(true);
    expect(secondPermissions).toHaveLength(1);
    expect(await readFile(join(dir, "sandbox", "notes", "answer.txt"), "utf8")).toBe("初始内容");

    await abandonedPrompt;
    second.close();
    await second.closed;
  });

  it("授权被拒绝时不调用 FileSandbox 写入，也不产生目标文件", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
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
      toolStart: /** 构造「toolStart」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => undefined,
      toolFinish: /** 构造「toolFinish」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => undefined,
      requestPermission: /** 构造「requestPermission」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => false,
      askUser: /** 构造「askUser」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => "",
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

  it("文件工具完成后不创建预览引用，等待显式发布", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const dir = await tempDir();
    const sandbox = new FileSandbox(join(dir, "sandbox"));
    await sandbox.initialize();
    const sessions = new SessionRepository(join(dir, "data"));
    const provider = new WriteThenWaitProvider();
    const agent = new KindergartenAgent(
      sessions,
      AgentRuntime.fromRegistry(provider, new ToolRegistry(sandbox)),
      testBindings(),
    ).createApp();
    const updates: acp.SessionNotification[] = [];
    const client = acp.client({ name: "streamed-artifact-page" })
      .onNotification(acp.methods.client.session.update, /** 构造「onRequest」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
({ params }) => { updates.push(params); })
      .onRequest(acp.methods.client.session.requestPermission, /** 构造「connect」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => ({
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

    await vi.waitFor(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
() => expect(updates.some(/** 构造「toBe」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(notice) => {
      const update = notice.update;
      return update.sessionUpdate === "tool_call_update" && update.toolCallId === "streamed-write" && update.status === "completed";
    })).toBe(true));
    expect(updates.some(/** 构造「toBe」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(notice) => {
      const update = notice.update;
      return update.sessionUpdate === "tool_call_update" && update.content?.some(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(item) =>
        item.type === "content" && item.content.type === "resource_link" && item.content.uri.startsWith("mk-file://"));
    })).toBe(false);

    provider.continueSecondRound();
    await prompt;
    client.close();
    await client.closed;
  });

  it.runIf(process.platform === "darwin")("模型即使请求已隐藏的命令工具也不会执行或创建预览引用", /** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
async () => {
    const dir = await tempDir();
    const sandbox = new FileSandbox(join(dir, "sandbox"));
    await sandbox.initialize();
    await sandbox.writeText("index.html", "<h1>旧版本</h1>");
    const sessions = new SessionRepository(join(dir, "data"));
    const provider = new CommandThenWaitProvider();
    const agent = new KindergartenAgent(
      sessions,
      AgentRuntime.fromRegistry(provider, new ToolRegistry(sandbox)),
      testBindings(),
    ).createApp();
    const updates: acp.SessionNotification[] = [];
    const client = acp.client({ name: "command-artifact-page" })
      .onNotification(acp.methods.client.session.update, /** 构造「onRequest」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
({ params }) => { updates.push(params); })
      .onRequest(acp.methods.client.session.requestPermission, /** 构造「connect」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => ({
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

    expect(updates.some(/** 构造「toBe」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(notice) => {
      const update = notice.update;
      return update.sessionUpdate === "tool_call_update" && update.toolCallId === "streamed-command" &&
        update.content?.some(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(item) => item.type === "content" && item.content.type === "resource_link");
    })).toBe(false);
    expect(await sandbox.readText("index.html")).toMatchObject({ content: "<h1>旧版本</h1>" });

    provider.continueSecondRound();
    await prompt;
    client.close();
    await client.closed;
  });

  it("文件写入成功后，即使 Turn 后续失败也不创建预览引用", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const dir = await tempDir();
    const sandbox = new FileSandbox(join(dir, "sandbox"));
    await sandbox.initialize();
    const sessions = new SessionRepository(join(dir, "data"));
    const agent = new KindergartenAgent(
      sessions,
      AgentRuntime.fromRegistry(new WriteThenFailProvider(), new ToolRegistry(sandbox)),
      testBindings(),
    ).createApp();
    const client = acp.client({ name: "failed-artifact-page" })
      .onRequest(acp.methods.client.session.requestPermission, /** 构造「connect」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => ({
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
    });
    expect(stored.turns[0]?.fileReferenceIds).toBeUndefined();
    const write = stored.sessionEntries.find(/** 构造「write」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(entry): entry is SessionToolCallEntry =>
      entry.type === "tool_call" && entry.name === "write_file");
    expect(write?.content.some(/** 构造「toBe」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(item) => item.type === "content" && item.content.type === "resource_link"))
      .toBe(false);
    expect(await readFile(join(dir, "sandbox", "index.html"), "utf8")).toBe("<h1>完成</h1>");

    client.close();
    await client.closed;
  });

});

/** 构造「testBindings」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function testBindings(): SessionBindingService {
  return new SessionBindingService({
    workspaceCwd: "/workspace",
    agentExists: /** 构造「agentExists」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(id) => id === "agent-1",
    modelStudentReady: /** 构造「modelStudentReady」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(id) => id === "student-1",
    experimentBinding: /** 构造「experimentBinding」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => undefined,
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
  /** 构造「serializeContext」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
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

  /** 构造「stream」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async *stream(input: ModelInput): AsyncIterable<ModelEvent> {
    const results = input.messages.filter(/** 构造「results」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(item) => item.role === "tool");
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
  /** 构造「stream」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
override async *stream(input: ModelInput): AsyncIterable<ModelEvent> {
    if (!input.messages.some(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(item) => item.role === "tool")) {
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
  private readonly secondRound = new Promise<void>(/** 构造「secondRound」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(resolve) => { this.secondRoundStarted = resolve; });
  private readonly continuation = new Promise<void>(/** 构造「continuation」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(resolve) => { this.secondRoundContinued = resolve; });

  /** 构造「waitForSecondRound」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
waitForSecondRound(): Promise<void> { return this.secondRound; }
  /** 构造「continueSecondRound」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
continueSecondRound(): void { this.secondRoundContinued(); }

  /** 构造「stream」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
override async *stream(input: ModelInput): AsyncIterable<ModelEvent> {
    if (!input.messages.some(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(item) => item.role === "tool")) {
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
  private readonly secondRound = new Promise<void>(/** 构造「secondRound」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(resolve) => { this.secondRoundStarted = resolve; });
  private readonly continuation = new Promise<void>(/** 构造「continuation」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(resolve) => { this.secondRoundContinued = resolve; });

  /** 构造「waitForSecondRound」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
waitForSecondRound(): Promise<void> { return this.secondRound; }
  /** 构造「continueSecondRound」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
continueSecondRound(): void { this.secondRoundContinued(); }

  /** 构造「stream」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
override async *stream(input: ModelInput): AsyncIterable<ModelEvent> {
    if (!input.messages.some(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(item) => item.role === "tool")) {
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

/** 构造「tempDir」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kindergarten-tools-"));
  tempDirs.push(dir);
  return dir;
}

/** 构造「initialize」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async function initialize(client: acp.ClientConnection): Promise<void> {
  await client.agent.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: { elicitation: { form: {} } },
  });
}
