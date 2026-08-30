import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionRepository } from "../../src/repository/session-repository.js";
import { createProviderOpaqueContinuation } from "../../src/model/provider-continuation.js";

const dirs: string[] = [];
afterEach(/** 在每个测试后释放临时资源，保证后续场景从干净状态开始。 */
async () => Promise.all(dirs.splice(0).map(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(dir) => rm(dir, { recursive: true, force: true }))));

describe("SessionRepository V5", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("保存不可变身份并从普通列表隐藏 experiment Session", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const dir = await tempDir();
    const repository = new SessionRepository(dir, legacyDefaults);
    const chat = await repository.create({
      cwd: "/workspace", ownerId: "local-admin", purpose: "chat", modelStudentId: "student-1", agentId: "agent-1",
    });
    const experiment = await repository.create({
      cwd: "/workspace", ownerId: "local-admin", purpose: "experiment", modelStudentId: "student-1", agentId: "agent-1",
      experimentRef: { experimentId: "experiment-1", variantId: "b" },
    });

    expect(chat).toMatchObject({ schemaVersion: 5, purpose: "chat", modelStudentId: "student-1", agentId: "agent-1" });
    expect(experiment.experimentRef).toEqual({ experimentId: "experiment-1", variantId: "b" });
    expect((await repository.list()).map(/** 构造「toEqual」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(item) => item.sessionId)).toEqual([chat.id]);
    expect((await repository.list(null, "experiment")).map(/** 构造「toEqual」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(item) => item.sessionId)).toEqual([experiment.id]);
  });

  it("experiment 缺少 experimentRef 时拒绝创建", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const repository = new SessionRepository(await tempDir(), legacyDefaults);
    await expect(repository.create({
      cwd: "/workspace", ownerId: "local-admin", purpose: "experiment", modelStudentId: "student-1", agentId: "agent-1",
    })).rejects.toThrow("experimentRef");
  });

  it("持久化 Session 推理覆盖，并用 auto 恢复 ModelStudent 默认", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const repository = new SessionRepository(await tempDir(), legacyDefaults);
    const session = await repository.create({ cwd: "/workspace", ownerId: "local-admin", purpose: "chat", modelStudentId: "student-1", agentId: "agent-1" });
    expect((await repository.setReasoningOverride(session.id, "max")).reasoningOverride).toBe("max");
    expect((await repository.get(session.id)).reasoningOverride).toBe("max");
    expect((await repository.setReasoningOverride(session.id, undefined)).reasoningOverride).toBeUndefined();
    expect((await repository.get(session.id)).reasoningOverride).toBeUndefined();
  });

  it("Turn 保存 Agent、能力、Context 和 Provider 输入的不可变快照", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const repository = new SessionRepository(await tempDir(), legacyDefaults);
    const session = await repository.create({ cwd: "/workspace", ownerId: "local-admin", purpose: "chat", modelStudentId: "student-1", agentId: "agent-1" });
    await repository.startTurn(session.id, "turn-1", {
      promptEntryId: "message-1",
      modelStudentId: "student-1",
      providerKind: "ollama",
      model: "qwen3:8b",
      agentId: "agent-1",
      agentSnapshotHash: "hash-1",
      agentSnapshot: { systemPrompt: "旧提示词", builtinTools: [], builtinSkills: [], skills: [], mcps: [], historyPolicy: { mode: "none" }, memoryPolicy: { mode: "off" } },
      capabilitySnapshots: [{ generation: 1, hash: "cap-1", snapshot: { tools: [], mcpServers: [], skills: [] } }],
      modelRounds: [{ roundIndex: 0, capabilityGeneration: 1, contextSummary: { schemaVersion: 1, turnId: "turn-1", items: [], totalEstimatedTokens: 0 }, providerInput: { provider: "ollama", model: "qwen3:8b", format: "json", value: "{}" }, startedAt: new Date().toISOString() }],
      resolvedReasoning: { schemaVersion: 1, requestedProfile: "auto", resolvedProfile: "deep", source: "model_default", providerKind: "ollama", model: "qwen3:8b", native: { think: true } },
    });
    await repository.transitionTurn(session.id, "turn-1", "finalizing");
    await repository.finishTurn(session.id, "turn-1", "completed", { stopReason: "end_turn" });
    const turn = (await repository.get(session.id)).turns[0];
    expect(turn).toMatchObject({ state: { status: "completed" }, agentSnapshotHash: "hash-1", stopReason: "end_turn" });
    expect(turn?.resolvedReasoning?.native).toEqual({ think: true });
    expect(turn?.modelRounds?.[0]).toMatchObject({ providerInputHash: expect.any(String), providerInputBytes: 2 });
    expect(await repository.readProviderInput(session.id, "turn-1", 0)).toMatchObject({ value: "{}" });
  });

  it("running Turn 的解析策略与 Model Round checkpoint 可在终态前读取", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const repository = new SessionRepository(await tempDir(), legacyDefaults);
    const session = await repository.create({ cwd: "/workspace", ownerId: "local-admin", purpose: "chat", modelStudentId: "student-1", agentId: "agent-1" });
    await repository.startTurn(session.id, "turn-running", { promptEntryId: "message-running" });
    const resolvedReasoning = {
      schemaVersion: 1 as const,
      requestedProfile: "max" as const,
      resolvedProfile: "max" as const,
      source: "session_override" as const,
      providerKind: "openai-compatible",
      model: "gpt-5.5",
      native: { effort: "xhigh" },
    };
    await repository.checkpointTurn(session.id, "turn-running", {
      modelStudentId: "student-1",
      providerKind: "openai-compatible",
      model: "gpt-5.5",
      agentId: "agent-1",
      resolvedReasoning,
    });
    await repository.checkpointTurn(session.id, "turn-running", {
      modelRounds: [{
        roundIndex: 0,
        capabilityGeneration: 1,
        contextSummary: { schemaVersion: 1, turnId: "turn-running", items: [], totalEstimatedTokens: 0 },
        providerInput: { provider: "openai-compatible", model: "gpt-5.5", format: "json", value: "{}" },
        startedAt: "2026-08-13T00:00:00.000Z",
        resolvedReasoning,
      }],
    });

    const running = (await repository.get(session.id)).turns[0];
    expect(running).toMatchObject({
      state: { status: "active", phase: "accepted", waitingFor: { permission: 0, input: 0 } },
      model: "gpt-5.5",
      resolvedReasoning: { resolvedProfile: "max", native: { effort: "xhigh" } },
      modelRounds: [{ roundIndex: 0, resolvedReasoning: { resolvedProfile: "max" } }],
    });
  });

  it("允许在 Turn 终态后补齐已执行文件 Tool 的派生预览引用", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const repository = new SessionRepository(await tempDir(), legacyDefaults);
    const session = await repository.create({ cwd: "/workspace", ownerId: "local-admin", purpose: "chat", modelStudentId: "student-1", agentId: "agent-1" });
    await repository.startTurn(session.id, "turn-file", { promptEntryId: "message-file" });
    await repository.transitionTurn(session.id, "turn-file", "finalizing");
    await repository.finishTurn(session.id, "turn-file", "failed", {
      error: { code: "MODEL_FAILED", message: "写入后的模型轮失败", retryable: false },
    });
    const entry = {
      type: "tool_call" as const,
      turnId: "turn-file",
      toolCallId: "write-file",
      title: "写入 index.html",
      name: "write_file",
      kind: "edit" as const,
      status: "completed" as const,
      rawInput: { path: "index.html" },
      rawOutput: { path: "/workspace/index.html" },
      modelContent: "ok",
      outcomeStatus: "success" as const,
      content: [{
        type: "content" as const,
        content: {
          type: "resource_link" as const,
          name: "index.html",
          uri: "mk-file://file_1234567890abcdef1234567890abcdef",
        },
      }],
      locations: [],
      createdAt: "2026-08-17T00:00:00.000Z",
    };

    const turn = await repository.attachTurnFileReferences(
      session.id,
      "turn-file",
      [entry],
      ["file_1234567890abcdef1234567890abcdef"],
    );

    expect(turn).toMatchObject({
      state: { status: "failed" },
      fileReferenceIds: ["file_1234567890abcdef1234567890abcdef"],
    });
    expect((await repository.get(session.id)).sessionEntries).toContainEqual(entry);
  });

  it("原子保存用户消息与 Turn，并在重启恢复时保留消息、收敛运行状态", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const repository = new SessionRepository(await tempDir(), legacyDefaults);
    const session = await repository.create({ cwd: "/workspace", ownerId: "local-admin", purpose: "chat", modelStudentId: "student-1", agentId: "agent-1" });
    await repository.startTurnWithPrompt(session.id, "turn-atomic", {
      type: "message", role: "user", text: "已经落盘的请求", turnId: "turn-atomic", messageId: "message-atomic", createdAt: "2026-08-13T01:00:00.000Z",
    });

    expect(await repository.recoverInterruptedTurns()).toBe(1);
    const recovered = await repository.get(session.id);
    expect(recovered.title).toBe("已经落盘的请求");
    expect(recovered.sessionEntries).toContainEqual(expect.objectContaining({ messageId: "message-atomic", text: "已经落盘的请求" }));
    expect(recovered.turns[0]).toMatchObject({ state: { status: "interrupted" }, error: { code: "TURN_INTERRUPTED", retryable: true } });
  });

  it("修复旧版 running Turn 中只写入 Provider 快照、未写入 Session 的用户消息", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const repository = new SessionRepository(await tempDir(), legacyDefaults);
    const session = await repository.create({ cwd: "/workspace", ownerId: "local-admin", purpose: "chat", modelStudentId: "student-1", agentId: "agent-1" });
    await repository.startTurn(session.id, "turn-legacy", { promptEntryId: "message-legacy" });
    await repository.checkpointTurn(session.id, "turn-legacy", {
      modelRounds: [{
        roundIndex: 0, capabilityGeneration: 1,
        contextSummary: { schemaVersion: 1, turnId: "turn-legacy", items: [], totalEstimatedTokens: 0 },
        providerInput: { provider: "ollama", model: "qwen3:8b", format: "json", value: JSON.stringify({ messages: [{ role: "system", content: "规则" }, { role: "user", content: "恢复这条消息" }] }) },
        startedAt: "2026-08-13T02:00:00.000Z",
      }],
    });

    await repository.recoverInterruptedTurns();
    const recovered = await repository.get(session.id);
    expect(recovered.sessionEntries).toContainEqual(expect.objectContaining({ messageId: "message-legacy", text: "恢复这条消息" }));
    expect(recovered.turns[0]?.entryIds).toContain("message:message-legacy");
  });

  it("从 V3 显式迁移为 V5 分片，并保留旧文件备份", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const dir = await tempDir();
    const file = join(dir, "sessions.json");
    await writeFile(file, JSON.stringify({
      version: 3,
      sessions: [{ id: "legacy", revision: 2, cwd: "/workspace", title: "旧聊天", updatedAt: "2026-08-01T00:00:00.000Z", sessionEntries: [] }],
    }), "utf8");
    const repository = new SessionRepository(dir, legacyDefaults);
    expect(await repository.get("legacy")).toMatchObject({
      schemaVersion: 5, ownerId: "local-admin", purpose: "chat", modelStudentId: "student-1", agentId: "agent-1",
    });
    await repository.persistMigrations();
    expect(JSON.parse(await readFile(join(dir, "sessions.index.json"), "utf8"))).toMatchObject({ version: 5 });
    expect(JSON.parse(await readFile(`${file}.v3.bak`, "utf8"))).toMatchObject({ version: 3 });
  });

  it("旧 Session 首次迁移时也拒绝伪造的 Provider continuation", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "sessions.json"), JSON.stringify({
      version: 3,
      sessions: [{
        id: "legacy-invalid",
        revision: 1,
        cwd: "/workspace",
        title: "旧聊天",
        updatedAt: "2026-08-01T00:00:00.000Z",
        sessionEntries: [{
          type: "provider_continuation",
          turnId: "turn-1",
          roundIndex: 0,
          visibleEntryIds: [],
          toolCallIds: [],
          continuation: {
            schemaVersion: 1,
            providerKind: "openai-compatible",
            model: "gpt-5.5",
            format: "openai-responses-output-v1",
            items: [null],
          },
          createdAt: "2026-08-01T00:00:00.000Z",
        }],
      }],
    }), "utf8");

    await expect(new SessionRepository(dir, legacyDefaults).get("legacy-invalid"))
      .rejects.toThrow("JSON 对象数组");
  });

  it("把当前 Responses v1 continuation 绑定到 Session 学生后迁移，并在重启后保留 v2", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const dir = await tempDir();
    const file = join(dir, "sessions.json");
    await writeFile(file, JSON.stringify({
      version: 3,
      sessions: [{
        id: "legacy-responses",
        revision: 1,
        cwd: "/workspace",
        title: "旧 Responses 聊天",
        updatedAt: "2026-08-01T00:00:00.000Z",
        sessionEntries: [{
          type: "provider_continuation",
          turnId: "turn-1",
          roundIndex: 0,
          visibleEntryIds: ["assistant-1"],
          toolCallIds: ["call-1"],
          continuation: {
            schemaVersion: 1,
            providerKind: "openai-compatible",
            model: "same-model",
            format: "openai-responses-output-v1",
            items: [{ type: "function_call", call_id: "call-1", name: "read_file", arguments: "{}" }],
          },
          createdAt: "2026-08-01T00:00:00.000Z",
        }],
      }],
    }), "utf8");

    const repository = new SessionRepository(dir, legacyDefaults);
    const migrated = await repository.get("legacy-responses");
    const entry = migrated.sessionEntries[0];
    expect(entry).toMatchObject({
      type: "provider_continuation",
      continuation: {
        schemaVersion: 2,
        modelStudentId: "student-1",
        protocol: "openai_responses",
        correlation: { messageIds: ["assistant-1"], toolCallIds: ["call-1"] },
      },
    });
    await repository.persistMigrations();
    const restarted = await new SessionRepository(dir).get("legacy-responses");
    expect(restarted.sessionEntries[0]).toEqual(entry);
  });

  it("写入时拒绝其他 ModelStudent 的 continuation，即使模型名相同", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const repository = new SessionRepository(await tempDir(), legacyDefaults);
    const session = await repository.create({
      cwd: "/workspace", ownerId: "local-admin", purpose: "chat", modelStudentId: "student-1", agentId: "agent-1",
    });
    const continuation = createProviderOpaqueContinuation({
      modelStudentId: "student-2",
      providerKind: "openai-compatible",
      protocol: "openai_responses",
      model: "same-model",
      format: "openai-responses-output-v1",
      payload: { items: [] },
    });

    await expect(repository.append(session.id, {
      type: "provider_continuation",
      turnId: "turn-1",
      roundIndex: 0,
      continuation,
      createdAt: "2026-08-01T00:00:00.000Z",
    })).rejects.toThrow("Session ModelStudent 不匹配");
  });
});

const legacyDefaults = { ownerId: "local-admin", modelStudentId: "student-1", agentId: "agent-1" };

/** 构造「tempDir」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mk-session-v4-"));
  dirs.push(dir);
  return dir;
}
