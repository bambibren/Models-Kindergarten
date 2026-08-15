import { createHash, randomUUID } from "node:crypto";
import {
  calculateExecutionScores,
  parseExperimentDraftInput,
  scoreManualDimensions,
  type ExperimentDraftInput,
  type ExperimentRecord,
  type ExperimentScorecard,
  type ExecutionMetricsSnapshot,
  type OutputAnnotationFacts,
  type PlanningAnnotationFacts,
  type UnderstandingAnnotationFacts,
} from "@kindergarten/contracts";
import type { AgentService } from "../agent/agent-service.js";
import type { SessionRepository } from "../repository/session-repository.js";
import { ApiProblemError } from "../server/api-problem.js";
import type { ModelStudentCatalog } from "../model/model-student-catalog.js";
import type { EvaluationTraceExporter } from "@kindergarten/evaluation-exporter";
import type { ExperimentRepository } from "./experiment-repository.js";
import type { EvaluationRecordReader } from "./evaluation-record-client.js";
import type { AnnotationWorksheetGenerator } from "./annotation-worksheet-generator.js";

export class ExperimentService {
  constructor(
    private readonly repository: ExperimentRepository,
    private readonly agents: AgentService,
    private readonly sessions: SessionRepository,
    private readonly models: ModelStudentCatalog,
    private readonly evaluations: EvaluationRecordReader,
    private readonly exporter?: EvaluationTraceExporter,
    private readonly worksheetGenerator?: AnnotationWorksheetGenerator,
  ) {}

  async create(raw: unknown, ownerId = "local-admin"): Promise<ExperimentRecord> {
    let input: ExperimentDraftInput;
    try { input = parseExperimentDraftInput(raw); }
    catch (error) { throw new ApiProblemError(400, "VALIDATION_FAILED", publicMessage(error), false); }
    if (!this.models.isReady(input.modelStudentId)) throw new ApiProblemError(409, "EXPERIMENT_NOT_RUNNABLE", "ModelStudent 不可用", false);
    await this.agents.get(input.sourceAgentId, ownerId);
    if (input.mode === "history_turn") await this.assertSourceTurn(input, ownerId);
    const experimentId = randomUUID();
    const runs = [];
    for (const variant of input.variants) {
      const agent = await this.agents.createExperimentPolicy(experimentId, variant, ownerId);
      runs.push({
        runId: randomUUID(),
        variantId: variant.variantId,
        agentId: agent.agentId,
        mode: variant.mode,
        status: "pending" as const,
        ...(variant.mode === "reuse_snapshot" && input.sourceTurnId ? { reusedTurnId: input.sourceTurnId } : {}),
        answerTexts: [],
      });
    }
    const now = new Date().toISOString();
    const record: ExperimentRecord = {
      schemaVersion: 1,
      experimentId,
      ownerId,
      name: input.name,
      mode: input.mode,
      status: "ready",
      modelStudentId: input.modelStudentId,
      sourceAgentId: input.sourceAgentId,
      promptText: input.promptText,
      ...(input.sourceTurnId ? { sourceTurnId: input.sourceTurnId } : {}),
      toolUseWasExpected: input.toolUseWasExpected,
      variants: input.variants,
      runs,
      createdAt: now,
      updatedAt: now,
    };
    await this.repository.put(record);
    return record;
  }

  async list(ownerId = "local-admin", savedOnly = false): Promise<ExperimentRecord[]> {
    return (await this.repository.list()).filter((item) => item.ownerId === ownerId && (!savedOnly || item.savedAt))
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async get(id: string, ownerId = "local-admin"): Promise<ExperimentRecord> {
    const value = await this.repository.get(id);
    if (!value || value.ownerId !== ownerId) throw new ApiProblemError(404, "NOT_FOUND", "Experiment 不存在", false);
    return value;
  }

  async binding(experimentId: string, variantId: string): Promise<{ modelStudentId: string; agentId: string } | undefined> {
    const experiment = await this.repository.get(experimentId);
    const run = experiment?.runs.find((item) => item.variantId === variantId);
    if (!experiment || !run || run.mode !== "rerun" || !["ready", "running", "partially_failed"].includes(experiment.status)) return undefined;
    return { modelStudentId: experiment.modelStudentId, agentId: run.agentId };
  }

  async markSessionCreated(experimentId: string, variantId: string, sessionId: string): Promise<void> {
    await this.updateRun(experimentId, variantId, (run) => ({ ...run, status: "session_created", acpSessionId: sessionId }));
  }

  async markRunStarted(experimentId: string, variantId: string, sessionId: string, turnId: string): Promise<void> {
    await this.updateRun(experimentId, variantId, (run) => ({
      ...run, status: "running", acpSessionId: sessionId, turnId, startedAt: new Date().toISOString(),
    }), "running");
  }

  async markRunClientFailure(experimentId: string, variantId: string, ownerId = "local-admin"): Promise<ExperimentRecord> {
    await this.get(experimentId, ownerId);
    const updated = await this.updateRun(experimentId, variantId, (run) => {
      if (["completed", "failed", "cancelled", "interrupted"].includes(run.status)) return run;
      return {
        ...run,
        status: "failed",
        error: { code: "INTERNAL_ERROR", message: "该实验 lane 未能启动或运行失败", retryable: true },
        completedAt: new Date().toISOString(),
      };
    });
    return this.refreshStatus(updated.experimentId);
  }

  async markRunFinished(
    experimentId: string,
    variantId: string,
    sessionId: string,
    turnId: string,
    status: "completed" | "failed" | "cancelled",
    answerTexts: string[],
    error?: unknown,
  ): Promise<void> {
    const experiment = await this.get(experimentId);
    let metrics: ExecutionMetricsSnapshot | undefined;
    try { metrics = await this.executionMetrics(experiment, variantId, sessionId, turnId); }
    catch (error) { console.warn(`Experiment 执行指标暂不可用：${publicMessage(error)}`); }
    const session = await this.sessions.get(sessionId).catch(() => undefined);
    const turn = session?.turns.find((item) => item.turnId === turnId);
    const runtimeFacts = turn ? runtimeFactsFromTurn(turn) : this.traceRuntimeFacts(sessionId, turnId);
    const updated = await this.updateRun(experimentId, variantId, (run) => ({
      ...run,
      status,
      acpSessionId: sessionId,
      turnId,
      answerTexts,
      ...(runtimeFacts ? { runtimeFacts } : {}),
      ...(metrics ? { executionMetrics: metrics } : {}),
      ...(error ? { error: { code: "INTERNAL_ERROR", message: "该实验 lane 运行失败", retryable: true } as const } : {}),
      completedAt: new Date().toISOString(),
    }));
    await this.refreshStatus(updated.experimentId);
  }

  async completeReuseSnapshot(experimentId: string, variantId: string, ownerId = "local-admin"): Promise<ExperimentRecord> {
    const experiment = await this.get(experimentId, ownerId);
    const run = experiment.runs.find((item) => item.variantId === variantId);
    if (!run || run.mode !== "reuse_snapshot" || !run.reusedTurnId) {
      throw new ApiProblemError(409, "EXPERIMENT_NOT_RUNNABLE", "该 lane 不是可复用历史快照", false);
    }
    const reusedTurnId = run.reusedTurnId;
    const source = await this.findTurn(reusedTurnId, ownerId);
    this.assertSourceModelStudent(experiment.modelStudentId, source.modelStudentId);
    const answerTexts = source.sessionEntries.flatMap((entry) =>
      entry.type === "message" && entry.role === "assistant" && entry.turnId === reusedTurnId ? [entry.text] : []);
    const metrics = await this.executionMetrics(experiment, variantId, source.id, reusedTurnId);
    const sourceTurn = source.turns.find((item) => item.turnId === reusedTurnId);
    await this.updateRun(experimentId, variantId, (current) => ({
      ...current,
      status: "completed",
      acpSessionId: source.id,
      turnId: reusedTurnId,
      answerTexts,
      executionMetrics: metrics,
      ...(sourceTurn ? { runtimeFacts: runtimeFactsFromTurn(sourceTurn) } : {}),
      ...(sourceTurn?.startedAt ? { startedAt: sourceTurn.startedAt } : {}),
      completedAt: sourceTurn?.completedAt ?? new Date().toISOString(),
    }));
    return this.refreshStatus(experimentId);
  }

  async save(experimentId: string, ownerId = "local-admin"): Promise<ExperimentRecord> {
    await this.get(experimentId, ownerId);
    return this.repository.update(experimentId, (item) => ({ ...item, savedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  }

  async delete(experimentId: string, ownerId = "local-admin"): Promise<{ removedExperimentSessionIds: string[] }> {
    const experiment = await this.get(experimentId, ownerId);
    for (const run of experiment.runs) await this.agents.delete(run.agentId, ownerId).catch(() => undefined);
    const removedExperimentSessionIds = await this.sessions.removeExperimentSessions(experimentId, ownerId);
    await this.repository.remove(experimentId);
    return { removedExperimentSessionIds };
  }

  async putAnnotations(
    experimentId: string,
    raw: unknown,
    ownerId = "local-admin",
  ): Promise<ExperimentScorecard> {
    const experiment = await this.get(experimentId, ownerId);
    if (!record(raw)) throw new ApiProblemError(400, "VALIDATION_FAILED", "人工注释必须是对象", false);
    const understanding = parseUnderstanding(raw.understanding);
    const planning = parsePlanning(raw.planning);
    const output = parseOutput(raw.output);
    validateAnnotationReferences(experiment, understanding, planning, output);
    const metrics = experiment.runs.map((run) => run.executionMetrics).filter((item): item is ExecutionMetricsSnapshot => Boolean(item));
    if (metrics.length !== experiment.runs.length) throw new ApiProblemError(409, "SCORECARD_INCOMPLETE", "所有 lane 完成运行后才能计算评分", false);
    const execution = calculateExecutionScores(metrics);
    const manual = scoreManualDimensions({
      variantIds: experiment.variants.map((item) => item.variantId),
      understanding,
      planning,
      output: { ...output, answers: experiment.runs.map((run) => ({ variantId: run.variantId, text: run.answerTexts.join("\n") })) },
    });
    const variants = execution.map((item) => {
      const dimensions = manual.byVariant[item.variantId] ?? {};
      const complete = manual.complete && dimensions.understanding !== undefined && dimensions.planning !== undefined && dimensions.output !== undefined;
      return {
        variantId: item.variantId,
        dimensionScores: { ...dimensions, execution: item.score },
        executionEvidence: { metrics: item.metrics, componentScores: item.components },
        ...(complete ? { totalScore: Math.round((dimensions.understanding! + dimensions.planning! + dimensions.output! + item.score) / 4) } : {}),
      };
    });
    const complete = manual.complete && variants.every((item) => item.totalScore !== undefined);
    const ranking = complete ? makeRanking(variants.map((item) => ({ variantId: item.variantId, totalScore: item.totalScore! }))) : undefined;
    const current = await this.repository.getScorecard(experimentId);
    const now = new Date().toISOString();
    const scorecard: ExperimentScorecard = {
      schemaVersion: 1,
      scorecardId: current?.scorecardId ?? randomUUID(),
      experimentId,
      rubric: rubric(),
      annotations: { understanding, planning, output },
      variants,
      ...(ranking ? { ranking, winnerVariantIds: ranking[0]?.variantIds ?? [] } : {}),
      status: complete ? "complete" : "draft",
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    await this.repository.putScorecard(scorecard);
    return scorecard;
  }

  async scorecard(experimentId: string, ownerId = "local-admin"): Promise<ExperimentScorecard | undefined> {
    await this.get(experimentId, ownerId);
    return this.repository.getScorecard(experimentId);
  }

  async generateAnnotationWorksheet(experimentId: string, force = false, ownerId = "local-admin") {
    const experiment = await this.get(experimentId, ownerId);
    if (experiment.annotationWorksheet && !force) return experiment.annotationWorksheet;
    if (!this.worksheetGenerator) throw new ApiProblemError(503, "WORKSHEET_GENERATOR_UNAVAILABLE", "标注题目生成器不可用", true);
    if (!experiment.runs.every((run) => run.status === "completed")) {
      throw new ApiProblemError(409, "WORKSHEET_NOT_READY", "所有 lane 完成后才能生成标注题目", true);
    }
    const evidence = [];
    for (const run of experiment.runs) {
      let toolEvents: Array<{ name: string; title: string; status: string }> = [];
      if (run.acpSessionId && run.turnId) {
        const session = await this.sessions.get(run.acpSessionId).catch(() => undefined);
        toolEvents = session?.sessionEntries.flatMap((entry) => entry.type === "tool_call" && entry.turnId === run.turnId
          ? [{ name: entry.name, title: entry.title, status: entry.outcomeStatus ?? entry.status }]
          : []) ?? [];
      }
      evidence.push({
        variantId: run.variantId,
        label: experiment.variants.find((item) => item.variantId === run.variantId)?.label ?? run.variantId,
        answer: run.answerTexts.join("\n"),
        toolEvents,
      });
    }
    const worksheet = await this.worksheetGenerator.generate(experiment, evidence);
    await this.repository.update(experimentId, (item) => ({ ...item, annotationWorksheet: worksheet, updatedAt: new Date().toISOString() }));
    if (force) await this.repository.deleteScorecard(experimentId);
    return worksheet;
  }

  async runtimeHistory(experimentId: string, ownerId = "local-admin") {
    const experiment = await this.get(experimentId, ownerId);
    if (experiment.mode !== "history_turn" || !experiment.sourceTurnId) return [];
    const source = await this.findTurn(experiment.sourceTurnId, ownerId);
    this.assertSourceModelStudent(experiment.modelStudentId, source.modelStudentId);
    return entriesBeforeTurn(source.sessionEntries, experiment.sourceTurnId);
  }

  private async updateRun(
    experimentId: string,
    variantId: string,
    change: (run: ExperimentRecord["runs"][number]) => ExperimentRecord["runs"][number],
    status?: ExperimentRecord["status"],
  ): Promise<ExperimentRecord> {
    return this.repository.update(experimentId, (experiment) => {
      if (!experiment.runs.some((run) => run.variantId === variantId)) throw new Error(`Experiment lane 不存在: ${variantId}`);
      return {
        ...experiment,
        ...(status ? { status } : {}),
        runs: experiment.runs.map((run) => run.variantId === variantId ? change(run) : run),
        updatedAt: new Date().toISOString(),
      };
    });
  }

  private async refreshStatus(id: string): Promise<ExperimentRecord> {
    return this.repository.update(id, (experiment) => {
      const statuses = experiment.runs.map((run) => run.status);
      const terminal = statuses.every((status) => ["completed", "failed", "cancelled", "interrupted"].includes(status));
      const completed = statuses.filter((status) => status === "completed").length;
      const status = terminal
        ? completed === statuses.length ? "completed" : completed > 0 ? "partially_failed" : "failed"
        : statuses.some((item) => item === "running" || item === "session_created") ? "running" : experiment.status;
      return { ...experiment, status, updatedAt: new Date().toISOString() };
    });
  }

  private async executionMetrics(
    experiment: ExperimentRecord,
    variantId: string,
    sessionId: string,
    turnId: string,
  ): Promise<ExecutionMetricsSnapshot> {
    await this.exporter?.flush();
    const trace = this.exporter?.trace(sessionId, turnId);
    let record: Awaited<ReturnType<EvaluationRecordReader["get"]>>;
    try { record = await this.evaluations.get(sessionId, turnId); }
    catch (error) {
      if (!trace) throw error;
      console.warn(`Evaluation API 暂不可用，使用 Remote 内存 Trace：${publicMessage(error)}`);
    }
    if (!record && !trace) throw new ApiProblemError(409, "TURN_SNAPSHOT_UNAVAILABLE", "该 Turn 没有可验证的 Runtime 指标", false);
    const result = record?.result;
    return {
      evaluationRecordId: record ? `${sessionId}:${turnId}` : trace?.traceId ?? `${sessionId}:${turnId}:pending`,
      variantId,
      normallyCompleted: result?.normallyCompleted ?? trace!.status === "completed",
      ...(result?.firstTokenLatencyMs !== undefined ? { firstTokenLatencyMs: result.firstTokenLatencyMs } : {}),
      totalDurationMs: result?.totalDurationMs ?? (trace ? Math.max(0, trace.completedAt - trace.startedAt) : 0),
      toolUseWasExpected: experiment.toolUseWasExpected,
      toolSuccessCount: result?.toolSuccessCount ?? trace?.toolCalls.filter((item) => item.status === "success").length ?? 0,
      toolFailureCount: result?.toolFailureCount ?? trace?.toolCalls.filter((item) => item.status === "error").length ?? 0,
      errorCount: result?.errorCount ?? trace?.errors.length ?? 0,
      permissionViolationCount: result?.permissionViolationCount ?? 0,
      hasRepeatedToolCall: result?.hasRepeatedToolCall ?? false,
      modelRoundCount: result?.modelRoundCount ?? trace?.modelRounds.length ?? 0,
      toolCallCount: result?.toolCallCount ?? trace?.toolCalls.length ?? 0,
      totalContextTokens: result?.totalContextTokens ?? 0,
      totalOutputTokens: result?.totalOutputTokens ?? 0,
    };
  }

  private traceRuntimeFacts(sessionId: string, turnId: string): import("@kindergarten/contracts").ExperimentRunRuntimeFacts | undefined {
    const trace = this.exporter?.trace(sessionId, turnId);
    if (!trace) return undefined;
    return {
      capabilityGenerations: trace.variant.capabilities ? 1 : 0,
      capabilityToolNames: trace.variant.toolNames,
      contextSources: trace.modelRounds[0]?.context.messages.map((item) => ({ kind: item.source, title: item.sourceId ?? item.source, estimatedTokens: item.estimatedTokens })) ?? [],
      usage: {
        schemaVersion: 1,
        turnId,
        modelRequests: trace.modelRounds.length,
        components: [],
        inputTokens: trace.modelRounds.reduce((total, item) => total + (item.context.inputTokens ?? 0), 0),
        outputTokens: trace.modelRounds.reduce((total, item) => total + (item.outputTokens ?? 0), 0),
      },
      ...(trace.stopReason ? { stopReason: trace.stopReason } : {}),
    };
  }

  private async assertSourceTurn(input: ExperimentDraftInput, ownerId: string): Promise<void> {
    const source = await this.findTurn(input.sourceTurnId!, ownerId);
    this.assertSourceModelStudent(input.modelStudentId, source.modelStudentId);
    if (!source.turns.some((item) => item.turnId === input.sourceTurnId && item.state.status === "completed")) {
      throw new ApiProblemError(409, "TURN_SNAPSHOT_UNAVAILABLE", "历史 Turn 没有可复用的完成快照", false);
    }
  }

  /**
   * Session 在 V1 固定绑定一个 ModelStudent。历史实验会复用 Provider 私有续接事实，
   * 因而源 Turn 和目标 lane 不能跨 ModelStudent；旧持久化记录同样在读取边界复核。
   */
  private assertSourceModelStudent(targetModelStudentId: string, sourceModelStudentId: string): void {
    if (targetModelStudentId === sourceModelStudentId) return;
    throw new ApiProblemError(
      409,
      "EXPERIMENT_NOT_RUNNABLE",
      "历史 Turn 与实验目标必须绑定同一个 ModelStudent",
      false,
      [{ path: "modelStudentId", message: "必须与 sourceTurnId 所属 Session 的 modelStudentId 一致" }],
    );
  }

  private async findTurn(turnId: string, ownerId: string) {
    for (const session of await this.sessions.allForRuntime("chat")) {
      if (session.ownerId === ownerId && session.turns.some((item) => item.turnId === turnId)) return session;
    }
    throw new ApiProblemError(404, "TURN_SNAPSHOT_UNAVAILABLE", "历史 Turn 不存在", false);
  }
}

function parseUnderstanding(value: unknown): UnderstandingAnnotationFacts {
  if (!record(value) || !Array.isArray(value.requirements) || !Array.isArray(value.marks)) throw validation("理解注释格式无效");
  return {
    requirements: value.requirements.map((item) => {
      if (!record(item) || typeof item.requirementId !== "string" || typeof item.label !== "string" || typeof item.weight !== "number" || item.weight <= 0) throw validation("理解需求格式无效");
      return { requirementId: item.requirementId, label: item.label, weight: item.weight };
    }),
    marks: value.marks.map((item) => {
      if (!record(item) || typeof item.variantId !== "string" || typeof item.requirementId !== "string" || (item.verdict !== "met" && item.verdict !== "missed")) throw validation("理解标记格式无效");
      return { variantId: item.variantId, requirementId: item.requirementId, verdict: item.verdict };
    }),
    ...(typeof value.completedAt === "string" ? { completedAt: value.completedAt } : {}),
  };
}
function parsePlanning(value: unknown): PlanningAnnotationFacts {
  if (!record(value) || !Array.isArray(value.marks)) throw validation("规划注释格式无效");
    return { marks: value.marks.map((item) => {
    if (!record(item) || typeof item.variantId !== "string" || typeof item.stepId !== "string" || !["effective", "partial", "none"].includes(String(item.verdict))) throw validation("规划标记格式无效");
    return { variantId: item.variantId, stepId: item.stepId, verdict: item.verdict as "effective" | "partial" | "none" };
  }), ...(typeof value.completedAt === "string" ? { completedAt: value.completedAt } : {}) };
}
function parseOutput(value: unknown): OutputAnnotationFacts {
  if (!record(value) || !Array.isArray(value.marks)) throw validation("输出注释格式无效");
  return { marks: value.marks.map((item) => {
    if (!record(item) || typeof item.variantId !== "string" || typeof item.answerSectionId !== "string" || typeof item.start !== "number" || typeof item.end !== "number" ||
      !["effective", "partial", "none"].includes(String(item.verdict)) || typeof item.quotedTextHash !== "string") throw validation("输出标记格式无效");
    return { variantId: item.variantId, answerSectionId: item.answerSectionId, start: item.start, end: item.end, verdict: item.verdict as "effective" | "partial" | "none", quotedTextHash: item.quotedTextHash };
  }), ...(typeof value.completedAt === "string" ? { completedAt: value.completedAt } : {}) };
}
function validateAnnotationReferences(experiment: ExperimentRecord, understanding: UnderstandingAnnotationFacts, planning: PlanningAnnotationFacts, output: OutputAnnotationFacts): void {
  const worksheet = experiment.annotationWorksheet;
  if (!worksheet) throw new ApiProblemError(409, "WORKSHEET_NOT_READY", "请先生成标注题目", true);
  const variants = new Set(experiment.variants.map((item) => item.variantId));
  const expectedRequirements = new Map(worksheet.requirements.map((item) => [item.requirementId, item]));
  const requirements = new Set(understanding.requirements.map((item) => item.requirementId));
  if (understanding.requirements.length !== worksheet.requirements.length || understanding.requirements.some((item) => {
    const expected = expectedRequirements.get(item.requirementId);
    return !expected || expected.label !== item.label || expected.weight !== item.weight;
  })) throw validation("理解题目与当前标注工作表不一致");
  if ([...understanding.marks, ...planning.marks, ...output.marks].some((item) => !variants.has(item.variantId))) throw validation("注释引用了未知 lane");
  if (understanding.marks.some((item) => !requirements.has(item.requirementId))) throw validation("理解标记引用了未知需求");
  const expectedPlanning = new Set(worksheet.workflows.flatMap((item) => item.steps.map((step) => `${item.variantId}:${step.stepId}`)));
  const actualPlanning = planning.marks.map((item) => `${item.variantId}:${item.stepId}`);
  if (new Set(actualPlanning).size !== actualPlanning.length || actualPlanning.some((key) => !expectedPlanning.has(key)) || (planning.completedAt && actualPlanning.length !== expectedPlanning.size)) throw validation("工作流标记与当前标注工作表不一致");
  const expectedOutput = new Map(worksheet.outputSections.flatMap((item) => item.sections.map((section) => [`${item.variantId}:${section.answerSectionId}`, section])));
  const actualOutput = output.marks.map((item) => `${item.variantId}:${item.answerSectionId}`);
  if (new Set(actualOutput).size !== actualOutput.length || actualOutput.some((key) => !expectedOutput.has(key)) || (output.completedAt && actualOutput.length !== expectedOutput.size)) throw validation("输出标记与当前标注工作表不一致");
  for (const mark of output.marks) {
    const answer = experiment.runs.find((run) => run.variantId === mark.variantId)?.answerTexts.join("\n") ?? "";
    const quoted = answer.slice(mark.start, mark.end);
    const expected = expectedOutput.get(`${mark.variantId}:${mark.answerSectionId}`);
    if (!expected || mark.start !== expected.start || mark.end !== expected.end || mark.quotedTextHash !== expected.quotedTextHash || mark.start < 0 || mark.end <= mark.start || mark.end > answer.length || sha256(quoted) !== mark.quotedTextHash) throw validation("输出标记范围或 quotedTextHash 无效");
  }
}
function rubric(): ExperimentScorecard["rubric"] { return {
  rubricId: "context_experiment_four_dimensions", rubricVersion: 1,
  dimensions: [
    { id: "understanding", source: "manual_annotation", weight: 0.25 },
    { id: "planning", source: "manual_annotation", weight: 0.25 },
    { id: "output", source: "manual_annotation", weight: 0.25 },
    { id: "execution", source: "runtime_metrics", weight: 0.25 },
  ], executionPolicy: { policyId: "runtime_execution_v1", policyVersion: 1 },
}; }
function makeRanking(values: Array<{ variantId: string; totalScore: number }>): Array<{ rank: number; variantIds: string[]; totalScore: number }> {
  const scores = [...new Set(values.map((item) => item.totalScore))].toSorted((a, b) => b - a);
  return scores.map((score, index) => ({ rank: index + 1, variantIds: values.filter((item) => item.totalScore === score).map((item) => item.variantId), totalScore: score }));
}
function validation(message: string): ApiProblemError { return new ApiProblemError(400, "VALIDATION_FAILED", message, false); }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function publicMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function entriesBeforeTurn(entries: import("../repository/session-types.js").SessionEntry[], turnId: string) {
  const start = entries.findIndex((entry) => entry.turnId === turnId);
  return structuredClone(start < 0 ? entries : entries.slice(0, start));
}
function runtimeFactsFromTurn(turn: import("../repository/session-types.js").TurnExecutionRecord): import("@kindergarten/contracts").ExperimentRunRuntimeFacts {
  const firstRound = turn.modelRounds?.[0];
  return {
    ...(turn.agentSnapshotHash ? { agentSnapshotHash: turn.agentSnapshotHash } : {}),
    capabilityGenerations: turn.capabilitySnapshots?.length ?? 0,
    capabilityToolNames: [...new Set(turn.capabilitySnapshots?.flatMap((item) => item.snapshot.tools.map((tool) => tool.modelName)) ?? [])],
    contextSources: firstRound?.contextSummary.items.map((item) => ({ kind: item.kind, title: item.title, estimatedTokens: item.estimatedTokens, ...(item.kind === "truncated_history" ? { truncated: true } : {}) })) ?? [],
    ...(firstRound ? { providerInputHash: createHash("sha256").update(firstRound.providerInput.value).digest("hex"), providerInputBytes: Buffer.byteLength(firstRound.providerInput.value) } : {}),
    ...(turn.usage ? { usage: turn.usage } : {}),
    ...(turn.stopReason ? { stopReason: turn.stopReason } : {}),
  };
}
