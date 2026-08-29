import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ContextPreviewResponseV2, ExperimentDraftV2 } from "@kindergarten/contracts";
import { AgentRepository } from "../../src/agent/agent-repository.js";
import { AgentService } from "../../src/agent/agent-service.js";
import type { EvaluationAccess } from "../../src/evaluation/evaluation-module.js";
import { ExperimentRepository } from "../../src/experiments/experiment-repository.js";
import { ExperimentService } from "../../src/experiments/experiment-service.js";
import type { ContextPreviewService } from "../../src/experiments/context-preview-service.js";
import { FixtureProvider } from "../../src/model/fixture-provider.js";
import { ModelStudentCatalog } from "../../src/model/model-student-catalog.js";
import { SessionRepository } from "../../src/repository/session-repository.js";

const dirs: string[] = [];
afterEach(/** 在每个测试后释放临时资源，保证后续场景从干净状态开始。 */
async () => Promise.all(dirs.splice(0).map(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(dir) => rm(dir, { recursive: true, force: true }))));

describe("ExperimentService V2", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("创建 draft 不创建隐藏 Agent、Run 或 Session", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const { service, agents, source } = await setup();
    const experiment = await service.create(draft(source));
    expect(experiment).toMatchObject({ schemaVersion: 2, status: "draft", runs: [] });
    expect((await agents.list({ limit: 100 })).items.map(/** 构造「toEqual」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(item) => item.agentId)).toEqual([source.agentId]);
    expect(await service.binding(experiment.experimentId, "test-a")).toBeUndefined();
  });

  it("prepare-run 原子冻结 Test 快照并按 Idempotency-Key 幂等", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const { service, source } = await setup();
    const created = await service.create(draft(source));
    const prepared = await service.prepareRun(created.experimentId, "prepare-1");
    expect(prepared.status).toBe("prepared");
    expect(prepared.snapshots).toHaveLength(2);
    expect(prepared.runs.map(/** 构造「toEqual」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(run) => [run.testId, run.status])).toEqual([
      ["test-a", "pending"], ["test-b", "pending"],
    ]);
    expect(await service.prepareRun(created.experimentId, "prepare-1")).toEqual(prepared);
    await expect(service.prepareRun(created.experimentId, "prepare-2")).rejects.toMatchObject({ code: "EXPERIMENT_READ_ONLY" });
    expect(await service.binding(created.experimentId, "test-b")).toMatchObject({
      modelStudentId: "fixture-student",
      agentId: source.agentId,
      experimentReasoning: { requestedProfile: "balanced", resolvedProfile: "balanced" },
    });
  });

  it("只有历史策略不同不构成有效差异", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const { service, source } = await setup({ ignoreHistory: true });
    const input = draft(source);
    input.tests[1]!.policy.historyPolicy = { mode: "recent_turns", maxTurns: 20 };
    input.tests[1]!.policy.systemPrompt = input.tests[0]!.policy.systemPrompt;
    const created = await service.create(input);
    await expect(service.prepareRun(created.experimentId, "prepare-same")).rejects.toMatchObject({
      code: "EXPERIMENT_NO_EFFECTIVE_DIFFERENCE",
    });
  });

  it("所有 Test 都以 fresh run 完成，删除时只清理实验 Session", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const { service, source, sessions } = await setup();
    const created = await service.create(draft(source));
    const prepared = await service.prepareRun(created.experimentId, "prepare-run");
    const userSession = await sessions.create({
      cwd: "/workspace", ownerId: "local-admin", purpose: "chat",
      modelStudentId: "fixture-student", agentId: source.agentId,
    });
    for (const run of prepared.runs) {
      const session = await sessions.create({
        cwd: "/workspace", ownerId: "local-admin", purpose: "experiment",
        modelStudentId: "fixture-student", agentId: source.agentId,
        experimentRef: { experimentId: created.experimentId, variantId: run.testId },
      });
      await service.markRunStarted(created.experimentId, run.testId, session.id, `turn-${run.testId}`);
      await service.markRunFinished(created.experimentId, run.testId, session.id, `turn-${run.testId}`, "completed", [`回答 ${run.testId}`]);
    }
    expect((await service.get(created.experimentId)).status).toBe("completed");
    const removed = await service.delete(created.experimentId);
    expect(removed.removedExperimentSessionIds).toHaveLength(2);
    expect((await sessions.all()).map(/** 构造「toEqual」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(item) => item.id)).toEqual([userSession.id]);
  });

  it("所有 lane 被取消时保留 cancelled 终态，不伪装成失败", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const { service, source, sessions } = await setup();
    const created = await service.create(draft(source));
    const prepared = await service.prepareRun(created.experimentId, "prepare-cancelled");
    for (const run of prepared.runs) {
      const session = await sessions.create({
        cwd: "/workspace", ownerId: "local-admin", purpose: "experiment",
        modelStudentId: "fixture-student", agentId: source.agentId,
        experimentRef: { experimentId: created.experimentId, variantId: run.testId },
      });
      await service.markRunStarted(created.experimentId, run.testId, session.id, `turn-${run.testId}`);
      await service.markRunFinished(created.experimentId, run.testId, session.id, `turn-${run.testId}`, "cancelled", []);
    }
    expect((await service.get(created.experimentId)).status).toBe("cancelled");
  });

  it("读取 V1 store 但拒绝修改或运行 legacy 记录", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const dir = await mkdtemp(join(tmpdir(), "mk-experiment-legacy-"));
    dirs.push(dir);
    const source = legacyRecord();
    await writeFile(join(dir, "experiments.json"), JSON.stringify({ schemaVersion: 1, records: [source] }));
    const { service } = await setup({ dir });
    expect((await service.get(source.experimentId)).schemaVersion).toBe(1);
    await expect(service.prepareRun(source.experimentId, "legacy")).rejects.toMatchObject({ code: "LEGACY_EXPERIMENT_READ_ONLY" });
    await expect(service.save(source.experimentId)).rejects.toMatchObject({ code: "LEGACY_EXPERIMENT_READ_ONLY" });
    expect(await service.binding(source.experimentId, "variant-a")).toBeUndefined();
  });
});

/** 构造「setup」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async function setup(options: { dir?: string; ignoreHistory?: boolean } = {}) {
  const dir = options.dir ?? await mkdtemp(join(tmpdir(), "mk-experiment-v2-"));
  if (!options.dir) dirs.push(dir);
  const agents = new AgentService(new AgentRepository(join(dir, "agents.json")), {
    builtinToolIds: /** 构造「builtinToolIds」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => ["read_file"], readySkillInstallationIds: /** 构造「readySkillInstallationIds」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => [], mcpCapabilities: /** 构造「mcpCapabilities」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => [],
  });
  const source = await agents.create(agentInput("source"));
  const sessions = new SessionRepository(dir);
  const evaluation: EvaluationAccess = { get: /** 构造「get」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => ({ result: {
    normallyCompleted: true, firstTokenLatencyMs: 20, totalDurationMs: 100,
    toolSuccessCount: 0, toolFailureCount: 0, errorCount: 0,
    permissionViolationCount: 0, hasRepeatedToolCall: false,
    modelRoundCount: 1, toolCallCount: 0, totalContextTokens: 10, totalOutputTokens: 3,
    truncatedContextItemCount: 0,
  } }), flush: async () => undefined, takeTrace: () => undefined };
  const fixture = new FixtureProvider();
  const previews = { previewTest: /** 构造「previewTest」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async (_prompt: string, test: ExperimentDraftV2["tests"][number]) =>
    preview(test, options.ignoreHistory === true) } as ContextPreviewService;
  const service = new ExperimentService(
    new ExperimentRepository(join(dir, "experiments.json"), join(dir, "scorecards.json")),
    agents, sessions, new ModelStudentCatalog(fixture, "ready"), evaluation,
    undefined, previews,
  );
  return { service, agents, sessions, source };
}

/** 构造「draft」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function draft(source: { agentId: string; name: string; updatedAt: string }): ExperimentDraftV2 {
  const sourceAgent = { agentId: source.agentId, name: source.name, updatedAt: source.updatedAt };
  return {
    schemaVersion: 2,
    name: "上下文对照",
    promptText: "完成任务",
    toolUseWasExpected: false,
    worksheetModelStudentId: "fixture-student",
    tests: [
      { testId: "test-a", label: "A", sourceAgent, modelStudentId: "fixture-student", reasoningProfile: "auto", policy: policy("提示 A") },
      { testId: "test-b", label: "B", sourceAgent, modelStudentId: "fixture-student", reasoningProfile: "balanced", policy: policy("提示 B") },
    ],
  };
}

/** 构造「preview」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function preview(test: ExperimentDraftV2["tests"][number], ignoreHistory: boolean): ContextPreviewResponseV2 {
  const effective = JSON.stringify({
    model: test.modelStudentId,
    reasoning: test.reasoningProfile === "auto" ? "balanced" : test.reasoningProfile,
    prompt: test.policy.systemPrompt,
    ...(ignoreHistory ? {} : { tools: test.policy.builtinTools }),
  });
  return {
    schemaVersion: 2, runnable: true, diagnostics: [],
    agentSnapshotHash: `agent:${effective}`, capabilityHash: "capability-1",
    effectiveConfigurationHash: effective,
    contextSummary: { schemaVersion: 1, turnId: "preview", items: [], totalEstimatedTokens: 10 },
    providerInput: { provider: "fixture", model: "fixture", format: "json", value: effective },
    providerInputHash: `input:${effective}`, providerInputBytes: effective.length,
    resolvedReasoning: {
      schemaVersion: 1, requestedProfile: test.reasoningProfile,
      resolvedProfile: test.reasoningProfile === "auto" ? "balanced" : test.reasoningProfile,
      source: test.reasoningProfile === "auto" ? "model_default" : "session_override",
      providerKind: "fixture", model: "fixture", native: {},
    },
    model: { modelStudentId: "fixture-student", displayName: "Fixture", providerKind: "fixture", model: "fixture" },
    history: { configuredPolicy: test.policy.historyPolicy, actualHistoryTurns: 0 },
  };
}

/** 构造「policy」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function policy(systemPrompt: string) {
  return {
    systemPrompt,
    builtinTools: [],
    skillInstallationIds: [],
    mcps: [],
    historyPolicy: { mode: "none" as const },
    memoryPolicy: { mode: "off" as const },
  };
}

/** 构造「agentInput」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function agentInput(name: string) {
  return { name, systemPrompt: "提示", builtinTools: [], skillInstallationIds: [], mcps: [],
    historyPolicy: { mode: "none" as const }, memoryPolicy: { mode: "off" as const } };
}

/** 构造「legacyRecord」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function legacyRecord() {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1 as const,
    experimentId: "legacy-1", ownerId: "local-admin", name: "旧实验",
    mode: "history_turn" as const, status: "completed" as const,
    modelStudentId: "fixture-student", sourceAgentId: "legacy-agent",
    promptText: "旧问题", sourceTurnId: "old-turn", toolUseWasExpected: false,
    variants: [
      { variantId: "variant-a", label: "A" as const, mode: "reuse_snapshot" as const, policy: policy("A") },
      { variantId: "variant-b", label: "B" as const, mode: "rerun" as const, policy: policy("B") },
    ],
    runs: [], createdAt: now, updatedAt: now,
  };
}
