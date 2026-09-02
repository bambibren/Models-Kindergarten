import { createHash } from "node:crypto";
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
import { AnnotationWorksheetGenerator } from "../../src/experiments/annotation-worksheet-generator.js";
import type { ContextPreviewService } from "../../src/experiments/context-preview-service.js";
import { FixtureProvider } from "../../src/model/fixture-provider.js";
import type { ModelEvent, ModelInput } from "../../src/model/model-provider.js";
import { ModelStudentCatalog } from "../../src/model/model-student-catalog.js";
import { SessionRepository } from "../../src/repository/session-repository.js";

const dirs: string[] = [];
afterEach(/** 在每个测试后释放临时资源，保证后续场景从干净状态开始。 */
async () => Promise.all(dirs.splice(0).map(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(dir) => rm(dir, { recursive: true, force: true }))));

class CapturingFixtureProvider extends FixtureProvider {
  readonly inputs: string[] = [];

  override async *stream(input: ModelInput, signal: AbortSignal, onActivity?: () => void): AsyncIterable<ModelEvent> {
    this.inputs.push(input.messages.at(-1)?.content ?? "");
    yield* super.stream(input, signal, onActivity);
  }
}

describe("ExperimentService V2", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("创建 draft 不创建隐藏 Agent、Run 或 Session", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const { service, agents, source } = await setup();
    const experiment = await service.create(draft(source));
    expect(experiment).toMatchObject({ schemaVersion: 2, status: "draft", runs: [], worksheetModelStudentId: "fixture-student" });
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

  it("生成理解选项时每个实验 Turn 只提取第一条有效思考", async () => {
    const provider = new CapturingFixtureProvider();
    const { service, source, sessions } = await setup({ provider });
    const created = await service.create(draft(source));
    const prepared = await service.prepareRun(created.experimentId, "prepare-first-thought");
    for (const run of prepared.runs) {
      const turnId = `turn-${run.testId}`;
      const session = await sessions.create({
        cwd: "/workspace", ownerId: "local-admin", purpose: "experiment",
        modelStudentId: "fixture-student", agentId: source.agentId,
        experimentRef: { experimentId: created.experimentId, variantId: run.testId },
      });
      await service.markRunStarted(created.experimentId, run.testId, session.id, turnId);
      await sessions.append(session.id, { type: "thought", turnId, messageId: `empty-${run.testId}`, text: "   ", createdAt: new Date().toISOString() });
      await sessions.append(session.id, { type: "thought", turnId, messageId: `first-${run.testId}`, text: `首次思考 ${run.testId}`, createdAt: new Date().toISOString() });
      await sessions.append(session.id, { type: "thought", turnId, messageId: `later-${run.testId}`, text: `后续思考 ${run.testId}`, createdAt: new Date().toISOString() });
      await sessions.append(session.id, { type: "thought", turnId: `other-${run.testId}`, messageId: `other-${run.testId}`, text: `其他 Turn 思考 ${run.testId}`, createdAt: new Date().toISOString() });
      await sessions.append(session.id, { type: "message", role: "assistant", turnId, messageId: `answer-${run.testId}`, text: `正文 ${run.testId}`, createdAt: new Date().toISOString() });
      await service.markRunFinished(created.experimentId, run.testId, session.id, turnId, "completed", [`最终正文 ${run.testId}`]);
    }

    await service.generateAnnotationWorksheet(created.experimentId);

    expect(provider.inputs).toHaveLength(2);
    const understandingInput = provider.inputs[0]!;
    for (const run of prepared.runs) {
      expect(understandingInput).toContain(`首次思考 ${run.testId}`);
      expect(understandingInput).not.toContain(`后续思考 ${run.testId}`);
      expect(understandingInput).not.toContain(`其他 Turn 思考 ${run.testId}`);
      expect(understandingInput).not.toContain(`正文 ${run.testId}`);
      expect(understandingInput).not.toContain(`最终正文 ${run.testId}`);
    }
  });

  it("有产物的 lane 改用单个产物分，无产物 lane 仍保存任意文字选区", async () => {
    const { service, source, sessions, scoreResults } = await setup();
    const created = await service.create(draft(source));
    const prepared = await service.prepareRun(created.experimentId, "prepare-annotations");
    for (const run of prepared.runs) {
      const session = await sessions.create({
        cwd: "/workspace", ownerId: "local-admin", purpose: "experiment",
        modelStudentId: "fixture-student", agentId: source.agentId,
        experimentRef: { experimentId: created.experimentId, variantId: run.testId },
      });
      await service.markRunStarted(created.experimentId, run.testId, session.id, `turn-${run.testId}`);
      await sessions.append(session.id, {
        type: "thought",
        turnId: `turn-${run.testId}`,
        messageId: `thought-${run.testId}`,
        text: "先确认并完整回答用户任务。",
        createdAt: new Date().toISOString(),
      });
      if (run.testId === "test-a") await sessions.append(session.id, {
        type: "tool_call",
        turnId: `turn-${run.testId}`,
        toolCallId: "publish-a",
        title: "发布产物",
        name: "publish_artifact",
        kind: "edit",
        status: "completed",
        rawInput: {},
        outcomeStatus: "success",
        content: [{ type: "content", content: { type: "resource_link", uri: "artifact://artifact_test_a", name: "测试产物" } }],
        locations: [],
        createdAt: new Date().toISOString(),
      });
      await service.markRunFinished(created.experimentId, run.testId, session.id, `turn-${run.testId}`, "completed", [`回答 ${run.testId} 的完整方案`]);
    }
    const worksheet = await service.generateAnnotationWorksheet(created.experimentId);
    const runs = (await service.get(created.experimentId));
    if (runs.schemaVersion !== 2) throw new Error("测试只覆盖 V2");
    const artifactRun = runs.runs[0]!;
    const textRun = runs.runs[1]!;
    const answer = textRun.answerTexts.join("\n");
    const section = worksheet.outputSections.find((item) => item.variantId === textRun.testId)!.sections[0]!;
    const ranges = [
      { start: section.start, end: section.start + 2 },
      { start: section.start + 3, end: section.start + 5 },
    ];
    const selectedRequirements = [
      { ...worksheet.requirements[0]!, weight: 70 },
      { requirementId: "manual-other", label: "其他需求", weight: 30 },
    ];
    const scorecard = await service.putAnnotations(created.experimentId, {
      understanding: {
        requirements: selectedRequirements,
        marks: selectedRequirements.flatMap((requirement) => runs.tests.map((test) => ({
          variantId: test.testId,
          requirementId: requirement.requirementId,
          verdict: requirement.requirementId !== "manual-other" && requirement.matchedVariantIds?.includes(test.testId) ? "met" : "missed",
        }))),
        completedAt: new Date().toISOString(),
      },
      planning: {
        scores: runs.tests.map((test, index) => ({ variantId: test.testId, score: index === 0 ? 72 : 64 })),
        completedAt: new Date().toISOString(),
      },
      output: {
        artifactScores: [{ variantId: artifactRun.testId, score: 86 }],
        marks: [{
          markId: "legacy-artifact-text-mark",
          variantId: artifactRun.testId,
          answerSectionId: "旧标注会被清除",
          start: 0,
          end: 1,
          verdict: "effective",
          quotedTextHash: "旧标注不再校验",
        }, ...ranges.map((range, index) => ({
          markId: `mark-${index + 1}`,
          variantId: textRun.testId,
          answerSectionId: section.answerSectionId,
          start: range.start,
          end: range.end,
          verdict: index === 0 ? "effective" : "partial",
          quotedTextHash: createHash("sha256").update(answer.slice(range.start, range.end)).digest("hex"),
        }))],
        completedAt: new Date().toISOString(),
      },
    });

    expect(scorecard.status).toBe("complete");
    expect(scorecard.variants[0]?.dimensionScores.understanding).toBe(70);
    expect(scorecard.variants[0]?.dimensionScores.planning).toBe(72);
    expect(scorecard.annotations.planning.scores).toEqual(runs.tests.map((test, index) => ({ variantId: test.testId, score: index === 0 ? 72 : 64 })));
    expect(scorecard.annotations.output.artifactScores).toEqual([{ variantId: artifactRun.testId, score: 86 }]);
    expect(scorecard.annotations.output.marks).toHaveLength(2);
    expect(scorecard.annotations.output.marks.every((mark) => mark.variantId === textRun.testId)).toBe(true);
    expect(scorecard.variants[0]?.dimensionScores.output).toBe(86);
    expect(scorecard.variants[1]?.dimensionScores.output).toBeGreaterThan(0);
    expect(scorecard.variants.map((variant) => variant.scoreResultId)).toEqual(["score:test-a", "score:test-b"]);
    expect(scoreResults).toHaveLength(2);
    expect(scoreResults[0]).toMatchObject({
      source: { kind: "context_experiment", experimentId: created.experimentId, testId: "test-a" },
      modelStudentId: "fixture-student",
      agentConfiguration: { agentId: source.agentId, systemPrompt: "提示 A" },
      completed: true,
    });
    scoreResults.splice(0);
    await service.reconcileScoreResults();
    expect(scoreResults).toHaveLength(2);
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
async function setup(options: { dir?: string; ignoreHistory?: boolean; provider?: FixtureProvider } = {}) {
  const dir = options.dir ?? await mkdtemp(join(tmpdir(), "mk-experiment-v2-"));
  if (!options.dir) dirs.push(dir);
  const agents = new AgentService(new AgentRepository(join(dir, "agents.json")), {
    builtinToolIds: /** 构造「builtinToolIds」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => ["read_file"], readySkillInstallationIds: /** 构造「readySkillInstallationIds」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => Promise.resolve([]), mcpCapabilities: /** 构造「mcpCapabilities」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => Promise.resolve([]),
  });
  const source = await agents.create(agentInput("source"));
  const sessions = new SessionRepository(dir);
  const scoreResults: unknown[] = [];
  const evaluation: EvaluationAccess = { get: /** 构造「get」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => ({ result: {
    normallyCompleted: true, firstTokenLatencyMs: 20, totalDurationMs: 100,
    toolSuccessCount: 0, toolFailureCount: 0, errorCount: 0,
    permissionViolationCount: 0, hasRepeatedToolCall: false,
    modelRoundCount: 1, toolCallCount: 0, totalContextTokens: 10, totalOutputTokens: 3,
    truncatedContextItemCount: 0,
  } }), flush: async () => undefined, takeTrace: () => undefined,
  scoreResultId: (source) => `score:${source.kind === "context_experiment" ? source.testId : source.turnId}`,
  putScoreResult: async (input) => {
    scoreResults.push(input);
    return { ...input, schemaVersion: 1, scoreResultId: evaluation.scoreResultId(input.source), agentConfiguration: { ...input.agentConfiguration, configurationHash: "config" }, status: input.completed ? "complete" : "draft", createdAt: input.recordedAt ?? "now", updatedAt: input.recordedAt ?? "now" };
  },
  removeScoreResultsBySource: async () => undefined };
  const fixture = options.provider ?? new FixtureProvider();
  const previews = { previewTest: /** 构造「previewTest」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async (_prompt: string, test: ExperimentDraftV2["tests"][number]) =>
    preview(test, options.ignoreHistory === true) } as ContextPreviewService;
  const models = new ModelStudentCatalog(fixture, "ready");
  const service = new ExperimentService(
    new ExperimentRepository(join(dir, "experiments.json"), join(dir, "scorecards.json")),
    agents, sessions, models, evaluation,
    new AnnotationWorksheetGenerator(models), previews,
    { worksheetModelDisplayName: fixture.student.name },
  );
  return { service, agents, sessions, source, scoreResults };
}

/** 构造「draft」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function draft(source: { agentId: string; name: string; updatedAt: string }): ExperimentDraftV2 {
  const sourceAgent = { agentId: source.agentId, name: source.name, updatedAt: source.updatedAt };
  return {
    schemaVersion: 2,
    name: "上下文对照",
    promptText: "完成任务",
    toolUseWasExpected: false,
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
    builtinSkillIds: [],
    skillInstallationIds: [],
    mcps: [],
    historyPolicy: { mode: "none" as const },
    memoryPolicy: { mode: "off" as const },
  };
}

/** 构造「agentInput」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function agentInput(name: string) {
  return { name, systemPrompt: "提示", builtinTools: [], builtinSkillIds: [], skillInstallationIds: [], mcps: [],
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
