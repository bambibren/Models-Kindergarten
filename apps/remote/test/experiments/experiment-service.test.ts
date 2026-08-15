import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRepository } from "../../src/agent/agent-repository.js";
import { AgentService } from "../../src/agent/agent-service.js";
import type { EvaluationRecordReader } from "../../src/experiments/evaluation-record-client.js";
import { ExperimentRepository } from "../../src/experiments/experiment-repository.js";
import { ExperimentService } from "../../src/experiments/experiment-service.js";
import { AnnotationWorksheetGenerator } from "../../src/experiments/annotation-worksheet-generator.js";
import { FixtureProvider } from "../../src/model/fixture-provider.js";
import { ModelStudentCatalog } from "../../src/model/model-student-catalog.js";
import { SessionRepository } from "../../src/repository/session-repository.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("ExperimentService", () => {
  it("创建 2-3 lane，使用隐藏 policy Agent，普通 Agent 列表不展示", async () => {
    const { service, agents, sourceAgentId } = await setup();
    const experiment = await service.create(draft(sourceAgentId));
    expect(experiment.status).toBe("ready");
    expect(experiment.runs).toHaveLength(2);
    expect(await service.binding(experiment.experimentId, "variant-a")).toMatchObject({ modelStudentId: "fixture-student" });
    expect((await agents.list({ limit: 100 })).items.map((item) => item.agentId)).toEqual([sourceAgentId]);
  });

  it("Runtime 指标参与执行分；三个人工维度完成后生成四维总分、排名和 winner", async () => {
    const { service, sourceAgentId } = await setup();
    const experiment = await service.create(draft(sourceAgentId));
    for (const [index, run] of experiment.runs.entries()) {
      await service.markRunStarted(experiment.experimentId, run.variantId, `session-${index}`, `turn-${index}`);
      await service.markRunFinished(experiment.experimentId, run.variantId, `session-${index}`, `turn-${index}`, "completed", [index === 0 ? "理解需求并完成输出" : "仅完成输出"]);
    }
    expect((await service.get(experiment.experimentId)).status).toBe("completed");
    const worksheet = await service.generateAnnotationWorksheet(experiment.experimentId);
    const completedExperiment = await service.get(experiment.experimentId);
    for (const [index, output] of worksheet.outputSections.entries()) {
      expect(output.sections[0]?.start).toBe(0);
      expect(output.sections.at(-1)?.end).toBe(completedExperiment.runs[index]?.answerTexts.join("\n\n").length);
    }
    const completedAt = new Date().toISOString();
    const scorecard = await service.putAnnotations(experiment.experimentId, {
      understanding: {
        requirements: worksheet.requirements,
        marks: [
          { variantId: "variant-a", requirementId: worksheet.requirements[0]!.requirementId, verdict: "met" },
          { variantId: "variant-b", requirementId: worksheet.requirements[0]!.requirementId, verdict: "missed" },
        ],
        completedAt,
      },
      planning: {
        marks: [
          { variantId: "variant-a", stepId: worksheet.workflows[0]!.steps[0]!.stepId, verdict: "effective" },
          { variantId: "variant-b", stepId: worksheet.workflows[1]!.steps[0]!.stepId, verdict: "partial" },
        ],
        completedAt,
      },
      output: {
        marks: [
          outputMark("variant-a", worksheet.outputSections[0]!.sections[0]!, "effective"),
          outputMark("variant-b", worksheet.outputSections[1]!.sections[0]!, "partial"),
        ],
        completedAt,
      },
    });
    expect(scorecard.status).toBe("complete");
    expect(scorecard.variants[0]?.dimensionScores).toMatchObject({ understanding: 100, planning: 100, output: 100, execution: 100 });
    expect(scorecard.variants[0]?.totalScore).toBe(100);
    expect(scorecard.winnerVariantIds).toEqual(["variant-a"]);
  });

  it("注释未完成时不生成总分、排名或 winner", async () => {
    const { service, sourceAgentId } = await setup();
    const experiment = await service.create(draft(sourceAgentId));
    for (const [index, run] of experiment.runs.entries()) {
      await service.markRunStarted(experiment.experimentId, run.variantId, `s${index}`, `t${index}`);
      await service.markRunFinished(experiment.experimentId, run.variantId, `s${index}`, `t${index}`, "completed", ["回答"]);
    }
    const worksheet = await service.generateAnnotationWorksheet(experiment.experimentId);
    const scorecard = await service.putAnnotations(experiment.experimentId, {
      understanding: { requirements: worksheet.requirements, marks: [] },
      planning: { marks: [] }, output: { marks: [] },
    });
    expect(scorecard.status).toBe("draft");
    expect(scorecard).not.toHaveProperty("ranking");
    expect(scorecard).not.toHaveProperty("winnerVariantIds");
    expect(scorecard.variants.every((item) => item.totalScore === undefined)).toBe(true);
  });

  it("history A 复用原 Turn，且不创建实验 Session 或模型请求", async () => {
    const { service, sourceAgentId, sessions } = await setup();
    const source = await sessions.create({ cwd: "/workspace", ownerId: "local-admin", purpose: "chat", modelStudentId: "fixture-student", agentId: sourceAgentId });
    await sessions.appendMany(source.id, [
      { type: "message", role: "user", text: "原问题", turnId: "source-turn", messageId: "u", createdAt: new Date().toISOString() },
      { type: "message", role: "assistant", text: "原回答", turnId: "source-turn", messageId: "a", createdAt: new Date().toISOString() },
    ]);
    await sessions.startTurn(source.id, "source-turn");
    await sessions.transitionTurn(source.id, "source-turn", "finalizing");
    await sessions.finishTurn(source.id, "source-turn", "completed");
    const history = await service.create({
      ...draft(sourceAgentId), mode: "history_turn", promptText: "原问题", sourceTurnId: "source-turn",
      variants: [
        { variantId: "variant-a", label: "A", mode: "reuse_snapshot", policy: policy("提示 A") },
        { variantId: "variant-b", label: "B", mode: "rerun", policy: policy("提示 B") },
      ],
    });
    await service.completeReuseSnapshot(history.experimentId, "variant-a");
    const completed = await service.get(history.experimentId);
    expect(completed.runs[0]).toMatchObject({ status: "completed", acpSessionId: source.id, turnId: "source-turn", answerTexts: ["原回答"] });
    expect(await sessions.all("experiment")).toHaveLength(0);
  });

  it("拒绝把其他 ModelStudent 的历史 Turn 用作实验上下文", async () => {
    const { service, sourceAgentId, sessions } = await setup();
    const source = await completedSourceTurn(sessions, sourceAgentId, "another-student", "cross-model-turn");

    await expect(service.create({
      ...draft(sourceAgentId),
      mode: "history_turn",
      promptText: "原问题",
      sourceTurnId: source.turnId,
      variants: [
        { variantId: "variant-a", label: "A", mode: "reuse_snapshot", policy: policy("提示 A") },
        { variantId: "variant-b", label: "B", mode: "rerun", policy: policy("提示 B") },
      ],
    })).rejects.toMatchObject({
      status: 409,
      code: "EXPERIMENT_NOT_RUNNABLE",
      retryable: false,
      fieldErrors: [{ path: "modelStudentId" }],
    });
  });

  it("旧持久化实验在读取历史或复用快照时仍复核 ModelStudent 边界", async () => {
    const { service, sourceAgentId, sessions, experiments } = await setup();
    const source = await completedSourceTurn(sessions, sourceAgentId, "another-student", "legacy-cross-model-turn");
    const experiment = await service.create(draft(sourceAgentId));
    await experiments.update(experiment.experimentId, (current) => ({
      ...current,
      mode: "history_turn",
      sourceTurnId: source.turnId,
      variants: current.variants.map((variant, index) => index === 0
        ? { ...variant, mode: "reuse_snapshot" as const }
        : variant),
      runs: current.runs.map((run, index) => index === 0
        ? { ...run, mode: "reuse_snapshot" as const, reusedTurnId: source.turnId }
        : run),
    }));

    await expect(service.runtimeHistory(experiment.experimentId)).rejects.toMatchObject({
      status: 409,
      code: "EXPERIMENT_NOT_RUNNABLE",
    });
    await expect(service.completeReuseSnapshot(experiment.experimentId, "variant-a")).rejects.toMatchObject({
      status: 409,
      code: "EXPERIMENT_NOT_RUNNABLE",
    });
  });

  it("删除 Context 时只删除该实验产生的隐藏 Session，保留用户原会话", async () => {
    const { service, sourceAgentId, sessions } = await setup();
    const experiment = await service.create(draft(sourceAgentId));
    const userSession = await sessions.create({ cwd: "/workspace", ownerId: "local-admin", purpose: "chat", modelStudentId: "fixture-student", agentId: sourceAgentId });
    const hidden = await sessions.create({
      cwd: "/workspace", ownerId: "local-admin", purpose: "experiment", modelStudentId: "fixture-student",
      agentId: experiment.runs[0]!.agentId, experimentRef: { experimentId: experiment.experimentId, variantId: "variant-a" },
    });
    const result = await service.delete(experiment.experimentId);
    expect(result.removedExperimentSessionIds).toEqual([hidden.id]);
    expect((await sessions.all()).map((item) => item.id)).toEqual([userSession.id]);
    await expect(service.get(experiment.experimentId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "mk-experiment-"));
  dirs.push(dir);
  const agents = new AgentService(new AgentRepository(join(dir, "agents.json")), {
    builtinToolIds: () => ["read_file"], readySkillInstallationIds: () => [], mcpCapabilities: () => [],
  });
  const source = await agents.create(agentInput("source"));
  const sessions = new SessionRepository(dir);
  const evaluation: EvaluationRecordReader = {
    get: async (sessionId, turnId) => ({
      result: {
        normallyCompleted: true,
        firstTokenLatencyMs: 20,
        totalDurationMs: 100,
        toolSuccessCount: 0,
        toolFailureCount: 0,
        errorCount: 0,
        permissionViolationCount: 0,
        hasRepeatedToolCall: false,
        modelRoundCount: 1,
        toolCallCount: 0,
        totalContextTokens: sessionId.length,
        totalOutputTokens: turnId.length,
      },
    }),
  };
  const fixture = new FixtureProvider();
  const experiments = new ExperimentRepository(join(dir, "experiments.json"), join(dir, "scorecards.json"));
  const service = new ExperimentService(
    experiments,
    agents,
    sessions,
    new ModelStudentCatalog(fixture, "ready"),
    evaluation,
    undefined,
    new AnnotationWorksheetGenerator(fixture),
  );
  return { service, agents, sessions, experiments, sourceAgentId: source.agentId };
}

async function completedSourceTurn(
  sessions: SessionRepository,
  sourceAgentId: string,
  modelStudentId: string,
  turnId: string,
) {
  const session = await sessions.create({
    cwd: "/workspace",
    ownerId: "local-admin",
    purpose: "chat",
    modelStudentId,
    agentId: sourceAgentId,
  });
  await sessions.appendMany(session.id, [
    { type: "message", role: "user", text: "原问题", turnId, messageId: `${turnId}-user`, createdAt: new Date().toISOString() },
    { type: "message", role: "assistant", text: "原回答", turnId, messageId: `${turnId}-assistant`, createdAt: new Date().toISOString() },
  ]);
  await sessions.startTurn(session.id, turnId);
  await sessions.transitionTurn(session.id, turnId, "finalizing");
  await sessions.finishTurn(session.id, turnId, "completed");
  return { sessionId: session.id, turnId };
}

function draft(sourceAgentId: string) {
  return {
    name: "上下文对照",
    mode: "fresh_prompt",
    modelStudentId: "fixture-student",
    sourceAgentId,
    promptText: "完成任务",
    toolUseWasExpected: false,
    variants: [
      { variantId: "variant-a", label: "A", mode: "rerun", policy: policy("提示 A") },
      { variantId: "variant-b", label: "B", mode: "rerun", policy: policy("提示 B") },
    ],
  };
}
function policy(systemPrompt: string) { return { ...agentInput("policy"), systemPrompt }; }
function agentInput(name: string) { return {
  name, systemPrompt: "提示", builtinTools: [{ toolId: "read_file", enabled: true, permission: "allow" as const }],
  skillInstallationIds: [], mcps: [], historyPolicy: { mode: "none" as const, maxTurns: 0 }, memoryPolicy: { mode: "off" as const },
}; }
function outputMark(variantId: string, section: { answerSectionId: string; start: number; end: number; quotedTextHash: string }, verdict: "effective" | "partial") { return {
  variantId, answerSectionId: section.answerSectionId, start: section.start, end: section.end, verdict,
  quotedTextHash: section.quotedTextHash,
}; }
