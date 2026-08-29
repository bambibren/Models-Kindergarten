import { createHash, randomUUID } from "node:crypto";
import {
  calculateExecutionScores,
  parseExperimentDraftV2,
  scoreManualDimensions,
  stableJson,
  type AnyExperimentRecord,
  type ExperimentRecordV2,
  type ExperimentRunV2,
  type ExperimentScorecard,
  type ExperimentTestSnapshotV2,
  type ExecutionMetricsSnapshot,
  type OutputAnnotationFacts,
  type PlanningAnnotationFacts,
  type UnderstandingAnnotationFacts,
} from "@kindergarten/contracts";
import type { AgentService } from "../agent/agent-service.js";
import type { SessionRepository } from "../repository/session-repository.js";
import { ApiProblemError } from "../server/api-problem.js";
import type { ModelStudentCatalog } from "../model/model-student-catalog.js";
import type { ExperimentRepository } from "./experiment-repository.js";
import type { EvaluationAccess } from "../evaluation/evaluation-module.js";
import type { AnnotationWorksheetGenerator } from "./annotation-worksheet-generator.js";
import type { ContextPreviewService } from "./context-preview-service.js";

/** 描述「ExperimentService」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export class ExperimentService {
  /** 初始化「ExperimentService」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(
    private readonly repository: ExperimentRepository,
    private readonly agents: AgentService,
    private readonly sessions: SessionRepository,
    private readonly models: ModelStudentCatalog,
    private readonly evaluation: EvaluationAccess,
    private readonly worksheetGenerator?: AnnotationWorksheetGenerator,
    private readonly previews?: ContextPreviewService,
  ) {}

  /** 根据已校验输入构建「create」结果，不额外持有调用方的大对象。 */
async create(raw: unknown, ownerId = "local-admin"): Promise<ExperimentRecordV2> {
    let input;
    try { input = parseExperimentDraftV2(raw); }
    catch (error) { throw new ApiProblemError(400, "VALIDATION_FAILED", publicMessage(error), false); }
    await this.validateDraftDependencies(input, ownerId);
    const now = new Date().toISOString();
    const record: ExperimentRecordV2 = {
      schemaVersion: 2,
      experimentId: randomUUID(),
      ownerId,
      name: input.name,
      status: "draft",
      promptText: input.promptText,
      ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
      toolUseWasExpected: input.toolUseWasExpected,
      worksheetModelStudentId: input.worksheetModelStudentId,
      tests: input.tests,
      runs: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.repository.put(record);
    return record;
  }

  /** 更新「update」对应状态，并保持写入顺序、原子性与容量约束。 */
async update(experimentId: string, raw: unknown, ownerId = "local-admin"): Promise<ExperimentRecordV2> {
    const current = await this.getV2(experimentId, ownerId);
    if (current.status !== "draft") throw new ApiProblemError(409, "EXPERIMENT_READ_ONLY", "Experiment 已冻结，不能再修改", false);
    let input;
    try { input = parseExperimentDraftV2(raw); }
    catch (error) { throw new ApiProblemError(400, "VALIDATION_FAILED", publicMessage(error), false); }
    await this.validateDraftDependencies(input, ownerId);
    return this.repository.update(experimentId, /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(record) => {
      if (record.schemaVersion !== 2) throw legacyReadOnly();
      const { sourceRef: _sourceRef, ...withoutSourceRef } = record;
      return {
        ...withoutSourceRef,
        name: input.name,
        promptText: input.promptText,
        ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
        toolUseWasExpected: input.toolUseWasExpected,
        worksheetModelStudentId: input.worksheetModelStudentId,
        tests: input.tests,
        updatedAt: new Date().toISOString(),
      };
    }) as Promise<ExperimentRecordV2>;
  }

  /** 执行「prepareRun」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async prepareRun(experimentId: string, idempotencyKey: string, ownerId = "local-admin"): Promise<ExperimentRecordV2> {
    if (!idempotencyKey.trim()) throw new ApiProblemError(400, "VALIDATION_FAILED", "prepare-run 缺少 Idempotency-Key", false);
    const experiment = await this.getV2(experimentId, ownerId);
    if (experiment.status !== "draft") {
      if (experiment.prepareKey === idempotencyKey) return experiment;
      throw new ApiProblemError(409, "EXPERIMENT_READ_ONLY", "Experiment 已冻结，不能重复准备", false);
    }
    if (!this.previews) throw new ApiProblemError(503, "EXPERIMENT_PREVIEW_UNAVAILABLE", "上下文预检服务不可用", true);
    const previews = await Promise.all(experiment.tests.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(test) => this.previews!.previewTest(experiment.promptText, test, ownerId)));
    const diagnostics = previews.flatMap(/** 执行「diagnostics」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(preview, index) => preview.diagnostics.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => ({
      path: `tests.${index}.${item.path ?? "configuration"}`,
      message: item.message,
    })));
    if (diagnostics.length > 0) {
      throw new ApiProblemError(409, "EXPERIMENT_NOT_RUNNABLE", "至少一个 Test 的实际运行配置不可用", false, diagnostics);
    }
    if (new Set(previews.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.effectiveConfigurationHash)).size < 2) {
      throw new ApiProblemError(409, "EXPERIMENT_NO_EFFECTIVE_DIFFERENCE", "至少两个 Test 的实际运行配置需要不同", false);
    }
    const frozenAt = new Date().toISOString();
    const snapshots: ExperimentTestSnapshotV2[] = experiment.tests.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(test, index) => snapshotFromPreview(test, previews[index]!, frozenAt));
    const runs: ExperimentRunV2[] = snapshots.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(snapshot) => ({
      runId: randomUUID(),
      testId: snapshot.testId,
      snapshotId: snapshot.snapshotId,
      status: "pending",
      answerTexts: [],
    }));
    return this.repository.update(experimentId, /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(record) => {
      if (record.schemaVersion !== 2 || record.status !== "draft") throw new ApiProblemError(409, "EXPERIMENT_READ_ONLY", "Experiment 已冻结", false);
      return { ...record, status: "prepared", snapshots, runs, prepareKey: idempotencyKey, updatedAt: frozenAt };
    }) as Promise<ExperimentRecordV2>;
  }

  /** 读取「list」所需数据，并遵守作用域、分页与容量边界。 */
async list(ownerId = "local-admin", savedOnly = false): Promise<AnyExperimentRecord[]> {
    return (await this.repository.list()).filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.ownerId === ownerId && (!savedOnly || item.savedAt))
      .toSorted(/** 读取「list」所需数据，并遵守作用域、分页与容量边界。 */
(left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  /** 读取「get」所需数据，并遵守作用域、分页与容量边界。 */
async get(id: string, ownerId = "local-admin"): Promise<AnyExperimentRecord> {
    const value = await this.repository.get(id);
    if (!value || value.ownerId !== ownerId) throw new ApiProblemError(404, "NOT_FOUND", "Experiment 不存在", false);
    return value;
  }

  /** 读取「getV2」所需数据，并遵守作用域、分页与容量边界。 */
private async getV2(id: string, ownerId = "local-admin"): Promise<ExperimentRecordV2> {
    const value = await this.get(id, ownerId);
    if (value.schemaVersion !== 2) throw legacyReadOnly();
    return value;
  }

  /** 执行「binding」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async binding(experimentId: string, testId: string): Promise<{ modelStudentId: string; agentId: string; experimentReasoning: import("@kindergarten/contracts").ResolvedReasoningSnapshot } | undefined> {
    const experiment = await this.repository.get(experimentId);
    if (!experiment || experiment.schemaVersion !== 2 || !["prepared", "running"].includes(experiment.status)) return undefined;
    const run = experiment.runs.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.testId === testId);
    const snapshot = experiment.snapshots?.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.testId === testId && item.snapshotId === run?.snapshotId);
    if (!run || !snapshot || !["pending", "session_created", "running"].includes(run.status)) return undefined;
    return {
      modelStudentId: snapshot.model.modelStudentId,
      agentId: snapshot.sourceAgent.agentId,
      experimentReasoning: structuredClone(snapshot.reasoning),
    };
  }

  /** 执行「snapshot」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async snapshot(experimentId: string, testId: string): Promise<ExperimentTestSnapshotV2 | undefined> {
    const experiment = await this.repository.get(experimentId);
    if (!experiment || experiment.schemaVersion !== 2) return undefined;
    return structuredClone(experiment.snapshots?.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.testId === testId));
  }

  /** 执行「markSessionCreated」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async markSessionCreated(experimentId: string, variantId: string, sessionId: string): Promise<void> {
    await this.updateRun(experimentId, variantId, /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(run) => ({ ...run, status: "session_created", acpSessionId: sessionId }));
  }

  /** 执行「markRunStarted」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async markRunStarted(experimentId: string, variantId: string, sessionId: string, turnId: string): Promise<void> {
    await this.updateRun(experimentId, variantId, /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(run) => ({
      ...run, status: "running", acpSessionId: sessionId, turnId, startedAt: new Date().toISOString(),
    }), "running");
  }

  /** 执行「markRunClientFailure」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async markRunClientFailure(experimentId: string, variantId: string, ownerId = "local-admin"): Promise<ExperimentRecordV2> {
    await this.get(experimentId, ownerId);
    const updated = await this.updateRun(experimentId, variantId, /** 更新「updated」对应状态，并保持写入顺序、原子性与容量约束。 */
(run) => {
      if (["completed", "failed", "cancelled", "interrupted"].includes(run.status)) return run;
      return {
        ...run,
        status: "failed",
        error: { code: "INTERNAL_ERROR", message: "该实验 lane 未能启动或运行失败", retryable: false },
        completedAt: new Date().toISOString(),
      };
    });
    return this.refreshStatus(updated.experimentId) as Promise<ExperimentRecordV2>;
  }

  /** 执行「markRunFinished」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async markRunFinished(
    experimentId: string,
    variantId: string,
    sessionId: string,
    turnId: string,
    status: "completed" | "failed" | "cancelled",
    answerTexts: string[],
    error?: unknown,
  ): Promise<void> {
    const experiment = await this.getV2(experimentId);
    let metrics: ExecutionMetricsSnapshot | undefined;
    try { metrics = await this.executionMetrics(experiment, variantId, sessionId, turnId); }
    catch (error) { console.warn(`Experiment 执行指标暂不可用：${publicMessage(error)}`); }
    const session = await this.sessions.get(sessionId).catch(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => undefined);
    const turn = session?.turns.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.turnId === turnId);
    const runtimeFacts = turn ? runtimeFactsFromTurn(turn) : this.traceRuntimeFacts(sessionId, turnId);
    const updated = await this.updateRun(experimentId, variantId, /** 更新「updated」对应状态，并保持写入顺序、原子性与容量约束。 */
(run) => ({
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

  /** 更新「save」对应状态，并保持写入顺序、原子性与容量约束。 */
async save(experimentId: string, ownerId = "local-admin"): Promise<AnyExperimentRecord> {
    const experiment = await this.get(experimentId, ownerId);
    if (experiment.schemaVersion === 1) throw legacyReadOnly();
    return this.repository.update(experimentId, /** 更新「save」对应状态，并保持写入顺序、原子性与容量约束。 */
(item) => ({ ...item, savedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  }

  /** 释放或删除「delete」对应资源，重复调用仍保持安全。 */
async delete(experimentId: string, ownerId = "local-admin"): Promise<{ removedExperimentSessionIds: string[] }> {
    const experiment = await this.get(experimentId, ownerId);
    if (experiment.schemaVersion === 1) {
      for (const run of experiment.runs) await this.agents.delete(run.agentId, ownerId).catch(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => undefined);
    }
    const removedExperimentSessionIds = await this.sessions.removeExperimentSessions(experimentId, ownerId);
    await this.repository.remove(experimentId);
    return { removedExperimentSessionIds };
  }

  /** 判断「cancel」对应条件，只返回判定结果且不修改输入状态。 */
async cancel(experimentId: string, ownerId = "local-admin"): Promise<{ experiment: ExperimentRecordV2; activeSessionIds: string[] }> {
    const experiment = await this.getV2(experimentId, ownerId);
    if (["completed", "partially_failed", "failed", "cancelled", "interrupted"].includes(experiment.status)) {
      return { experiment, activeSessionIds: [] };
    }
    const activeSessionIds = experiment.runs.flatMap(/** 执行「activeSessionIds」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(run) =>
      run.acpSessionId && ["session_created", "running"].includes(run.status) ? [run.acpSessionId] : []);
    const now = new Date().toISOString();
    const updated = await this.repository.update(experimentId, /** 更新「updated」对应状态，并保持写入顺序、原子性与容量约束。 */
(record) => {
      if (record.schemaVersion !== 2) throw legacyReadOnly();
      return {
        ...record,
        status: "cancelled",
        runs: record.runs.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(run) => ["pending", "session_created", "running"].includes(run.status)
          ? { ...run, status: "cancelled" as const, completedAt: now }
          : run),
        updatedAt: now,
      };
    });
    return { experiment: updated as ExperimentRecordV2, activeSessionIds };
  }

  /** 更新「recordIntervention」对应状态，并保持写入顺序、原子性与容量约束。 */
async recordIntervention(experimentId: string, testId: string, raw: unknown, ownerId = "local-admin"): Promise<ExperimentRecordV2> {
    await this.getV2(experimentId, ownerId);
    if (!record(raw) || typeof raw.interactionId !== "string" ||
      (raw.kind !== "permission" && raw.kind !== "elicitation") ||
      typeof raw.summary !== "string" || typeof raw.decision !== "string") {
      throw new ApiProblemError(400, "VALIDATION_FAILED", "人工介入事实格式无效", false);
    }
    const fact: import("@kindergarten/contracts").ExperimentInterventionFact = {
      interactionId: raw.interactionId,
      kind: raw.kind,
      summary: raw.summary.slice(0, 1000),
      decision: raw.decision.slice(0, 200),
      operatorId: ownerId,
      resolvedAt: new Date().toISOString(),
    };
    return this.updateRun(experimentId, testId, /** 更新「recordIntervention」对应状态，并保持写入顺序、原子性与容量约束。 */
(run) => ({
      ...run,
      hadHumanIntervention: true,
      interventions: [...(run.interventions ?? []).filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.interactionId !== fact.interactionId), fact],
    }));
  }

  /** 更新「putAnnotations」对应状态，并保持写入顺序、原子性与容量约束。 */
async putAnnotations(
    experimentId: string,
    raw: unknown,
    ownerId = "local-admin",
  ): Promise<ExperimentScorecard> {
    const experiment = await this.getV2(experimentId, ownerId);
    if (!record(raw)) throw new ApiProblemError(400, "VALIDATION_FAILED", "人工注释必须是对象", false);
    const understanding = parseUnderstanding(raw.understanding);
    const planning = parsePlanning(raw.planning);
    const output = parseOutput(raw.output);
    validateAnnotationReferences(experiment, understanding, planning, output);
    const metrics = experiment.runs.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(run) => run.executionMetrics).filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item): item is ExecutionMetricsSnapshot => Boolean(item));
    if (metrics.length !== experiment.runs.length) throw new ApiProblemError(409, "SCORECARD_INCOMPLETE", "所有 lane 完成运行后才能计算评分", false);
    const execution = calculateExecutionScores(metrics);
    const manual = scoreManualDimensions({
      variantIds: experiment.tests.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.testId),
      understanding,
      planning,
      output: { ...output, answers: experiment.runs.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(run) => ({ variantId: run.testId, text: run.answerTexts.join("\n") })) },
    });
    const variants = execution.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => {
      const dimensions = manual.byVariant[item.variantId] ?? {};
      const complete = manual.complete && dimensions.understanding !== undefined && dimensions.planning !== undefined && dimensions.output !== undefined;
      return {
        variantId: item.variantId,
        dimensionScores: { ...dimensions, execution: item.score },
        executionEvidence: { metrics: item.metrics, componentScores: item.components },
        ...(complete ? { totalScore: Math.round((dimensions.understanding! + dimensions.planning! + dimensions.output! + item.score) / 4) } : {}),
      };
    });
    const complete = manual.complete && variants.every(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.totalScore !== undefined);
    const ranking = complete ? makeRanking(variants.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => ({ variantId: item.variantId, totalScore: item.totalScore! }))) : undefined;
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

  /** 执行「scorecard」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async scorecard(experimentId: string, ownerId = "local-admin"): Promise<ExperimentScorecard | undefined> {
    await this.get(experimentId, ownerId);
    return this.repository.getScorecard(experimentId);
  }

  /** 执行「generateAnnotationWorksheet」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async generateAnnotationWorksheet(experimentId: string, force = false, ownerId = "local-admin", worksheetModelStudentId?: string) {
    const experiment = await this.getV2(experimentId, ownerId);
    const selectedModelStudentId = worksheetModelStudentId?.trim() || experiment.worksheetModelStudentId;
    const replacingModel = selectedModelStudentId !== experiment.worksheetModelStudentId;
    if (experiment.annotationWorksheet && !force && !replacingModel) return experiment.annotationWorksheet;
    if (!this.models.isReady(selectedModelStudentId)) {
      throw new ApiProblemError(409, "EXPERIMENT_NOT_RUNNABLE", "所选评测辅助 ModelStudent 不可用", false);
    }
    if (!this.worksheetGenerator) throw new ApiProblemError(503, "WORKSHEET_GENERATOR_UNAVAILABLE", "标注题目生成器不可用", true);
    if (!experiment.runs.every(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(run) => run.status === "completed")) {
      throw new ApiProblemError(409, "WORKSHEET_NOT_READY", "所有 lane 完成后才能生成标注题目", true);
    }
    const evidence = [];
    for (const run of experiment.runs) {
      let toolEvents: Array<{ name: string; title: string; status: string }> = [];
      if (run.acpSessionId && run.turnId) {
        const session = await this.sessions.get(run.acpSessionId).catch(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => undefined);
        toolEvents = session?.sessionEntries.flatMap(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(entry) => entry.type === "tool_call" && entry.turnId === run.turnId
          ? [{ name: entry.name, title: entry.title, status: entry.outcomeStatus ?? entry.status }]
          : []) ?? [];
      }
      evidence.push({
        variantId: run.testId,
        label: experiment.tests.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.testId === run.testId)?.label ?? run.testId,
        answer: run.answerTexts.join("\n"),
        toolEvents,
      });
    }
    const generationExperiment = replacingModel ? { ...experiment, worksheetModelStudentId: selectedModelStudentId } : experiment;
    const worksheet = await this.worksheetGenerator.generate(generationExperiment, evidence);
    await this.repository.update(experimentId, /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(item) => ({
      ...item,
      worksheetModelStudentId: selectedModelStudentId,
      annotationWorksheet: worksheet,
      updatedAt: new Date().toISOString(),
    }));
    if (force || replacingModel) await this.repository.deleteScorecard(experimentId);
    return worksheet;
  }

  /** 执行「runtimeHistory」主流程，传播取消与失败并在结束时清理临时资源。 */
async runtimeHistory(experimentId: string, ownerId = "local-admin") {
    const experiment = await this.get(experimentId, ownerId);
    if (experiment.schemaVersion !== 2) throw legacyReadOnly();
    return [];
  }

  /** 更新「updateRun」对应状态，并保持写入顺序、原子性与容量约束。 */
private async updateRun(
    experimentId: string,
    variantId: string,
    change: (run: ExperimentRunV2) => ExperimentRunV2,
    status?: ExperimentRecordV2["status"],
  ): Promise<ExperimentRecordV2> {
    return this.repository.update(experimentId, /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(experiment) => {
      if (experiment.schemaVersion !== 2) throw legacyReadOnly();
      if (!experiment.runs.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(run) => run.testId === variantId)) throw new Error(`Experiment Test 不存在: ${variantId}`);
      return {
        ...experiment,
        ...(status ? { status } : {}),
        runs: experiment.runs.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(run) => run.testId === variantId ? change(run) : run),
        updatedAt: new Date().toISOString(),
      };
    }) as Promise<ExperimentRecordV2>;
  }

  /** 执行「refreshStatus」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
private async refreshStatus(id: string): Promise<ExperimentRecordV2> {
    return this.repository.update(id, /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(experiment) => {
      if (experiment.schemaVersion !== 2) throw legacyReadOnly();
      const statuses = experiment.runs.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(run) => run.status);
      const terminal = statuses.every(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(status) => ["completed", "failed", "cancelled", "interrupted"].includes(status));
      const completed = statuses.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(status) => status === "completed").length;
      const status = terminal
        ? completed === statuses.length
          ? "completed"
          : statuses.every(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item === "cancelled")
            ? "cancelled"
            : statuses.every(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item === "interrupted")
              ? "interrupted"
              : completed > 0
                ? "partially_failed"
                : "failed"
        : statuses.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item === "running" || item === "session_created") ? "running" : experiment.status;
      return { ...experiment, status, updatedAt: new Date().toISOString() };
    }) as Promise<ExperimentRecordV2>;
  }

  /** 执行「executionMetrics」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
private async executionMetrics(
    experiment: ExperimentRecordV2,
    variantId: string,
    sessionId: string,
    turnId: string,
  ): Promise<ExecutionMetricsSnapshot> {
    await this.evaluation.flush();
    const record = await this.evaluation.get(sessionId, turnId);
    const result = record?.result;
    if (!result) throw new ApiProblemError(409, "TURN_SNAPSHOT_UNAVAILABLE", "该 Turn 没有可验证的 Runtime 指标", false);
    return {
      evaluationRecordId: `${sessionId}:${turnId}`,
      variantId,
      normallyCompleted: result.normallyCompleted,
      ...(result.firstTokenLatencyMs !== undefined ? { firstTokenLatencyMs: result.firstTokenLatencyMs } : {}),
      totalDurationMs: requiredMetric(result.totalDurationMs, "totalDurationMs"),
      toolUseWasExpected: experiment.toolUseWasExpected,
      toolSuccessCount: requiredMetric(result.toolSuccessCount, "toolSuccessCount"),
      toolFailureCount: requiredMetric(result.toolFailureCount, "toolFailureCount"),
      errorCount: requiredMetric(result.errorCount, "errorCount"),
      permissionViolationCount: requiredMetric(result.permissionViolationCount, "permissionViolationCount"),
      hasRepeatedToolCall: result.hasRepeatedToolCall,
      modelRoundCount: requiredMetric(result.modelRoundCount, "modelRoundCount"),
      toolCallCount: requiredMetric(result.toolCallCount, "toolCallCount"),
      totalContextTokens: requiredMetric(result.totalContextTokens, "totalContextTokens"),
      totalOutputTokens: requiredMetric(result.totalOutputTokens, "totalOutputTokens"),
    };
  }

  /** 生成「traceRuntimeFacts」不可变视图，隔离后续状态修改并只暴露该层需要的事实。 */
private traceRuntimeFacts(sessionId: string, turnId: string): import("@kindergarten/contracts").ExperimentRunRuntimeFacts | undefined {
    const trace = this.evaluation.takeTrace(sessionId, turnId);
    if (!trace) return undefined;
    return {
      capabilityGenerations: trace.variant.capabilities ? 1 : 0,
      capabilityToolNames: trace.variant.toolNames,
      contextSources: trace.modelRounds[0]?.context.messages.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => ({ kind: item.source, title: item.sourceId ?? item.source, estimatedTokens: item.estimatedTokens })) ?? [],
      usage: {
        schemaVersion: 1,
        turnId,
        modelRequests: trace.modelRounds.length,
        components: [],
        inputTokens: trace.modelRounds.reduce(/** 把当前元素归并到有限累加状态，避免额外复制完整集合。 */
(total, item) => total + (item.context.inputTokens ?? 0), 0),
        outputTokens: trace.modelRounds.reduce(/** 把当前元素归并到有限累加状态，避免额外复制完整集合。 */
(total, item) => total + (item.outputTokens ?? 0), 0),
      },
      ...(trace.stopReason ? { stopReason: trace.stopReason } : {}),
    };
  }

  /** 校验并规范化「validateDraftDependencies」输入，非法数据直接返回明确错误。 */
private async validateDraftDependencies(input: import("@kindergarten/contracts").ExperimentDraftV2, ownerId: string): Promise<void> {
    if (!this.models.isReady(input.worksheetModelStudentId)) {
      throw new ApiProblemError(409, "EXPERIMENT_NOT_RUNNABLE", "评测辅助 ModelStudent 不可用", false);
    }
    for (const [index, test] of input.tests.entries()) {
      if (!this.models.isReady(test.modelStudentId)) {
        throw new ApiProblemError(409, "EXPERIMENT_NOT_RUNNABLE", `Test ${test.label} 的 ModelStudent 不可用`, false, [
          { path: `tests.${index}.modelStudentId`, message: "ModelStudent 必须为 Ready" },
        ]);
      }
      const agent = await this.agents.get(test.sourceAgent.agentId, ownerId);
      if (agent.name !== test.sourceAgent.name || agent.updatedAt !== test.sourceAgent.updatedAt) {
        throw new ApiProblemError(409, "EXPERIMENT_SOURCE_CHANGED", `Test ${test.label} 的来源 Agent 已变化，请重新导入`, false, [
          { path: `tests.${index}.sourceAgent`, message: "来源 Agent 快照标识已过期" },
        ]);
      }
    }
  }
}

/** 校验并规范化「parseUnderstanding」输入，非法数据直接返回明确错误。 */
function parseUnderstanding(value: unknown): UnderstandingAnnotationFacts {
  if (!record(value) || !Array.isArray(value.requirements) || !Array.isArray(value.marks)) throw validation("理解注释格式无效");
  return {
    requirements: value.requirements.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => {
      if (!record(item) || typeof item.requirementId !== "string" || typeof item.label !== "string" || typeof item.weight !== "number" || item.weight <= 0) throw validation("理解需求格式无效");
      return { requirementId: item.requirementId, label: item.label, weight: item.weight };
    }),
    marks: value.marks.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => {
      if (!record(item) || typeof item.variantId !== "string" || typeof item.requirementId !== "string" || (item.verdict !== "met" && item.verdict !== "missed")) throw validation("理解标记格式无效");
      return { variantId: item.variantId, requirementId: item.requirementId, verdict: item.verdict };
    }),
    ...(typeof value.completedAt === "string" ? { completedAt: value.completedAt } : {}),
  };
}
/** 校验并规范化「parsePlanning」输入，非法数据直接返回明确错误。 */
function parsePlanning(value: unknown): PlanningAnnotationFacts {
  if (!record(value) || !Array.isArray(value.marks)) throw validation("规划注释格式无效");
    return { marks: value.marks.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => {
    if (!record(item) || typeof item.variantId !== "string" || typeof item.stepId !== "string" || !["effective", "partial", "none"].includes(String(item.verdict))) throw validation("规划标记格式无效");
    return { variantId: item.variantId, stepId: item.stepId, verdict: item.verdict as "effective" | "partial" | "none" };
  }), ...(typeof value.completedAt === "string" ? { completedAt: value.completedAt } : {}) };
}
/** 校验并规范化「parseOutput」输入，非法数据直接返回明确错误。 */
function parseOutput(value: unknown): OutputAnnotationFacts {
  if (!record(value) || !Array.isArray(value.marks)) throw validation("输出注释格式无效");
  return { marks: value.marks.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => {
    if (!record(item) || typeof item.variantId !== "string" || typeof item.answerSectionId !== "string" || typeof item.start !== "number" || typeof item.end !== "number" ||
      !["effective", "partial", "none"].includes(String(item.verdict)) || typeof item.quotedTextHash !== "string") throw validation("输出标记格式无效");
    return { variantId: item.variantId, answerSectionId: item.answerSectionId, start: item.start, end: item.end, verdict: item.verdict as "effective" | "partial" | "none", quotedTextHash: item.quotedTextHash };
  }), ...(typeof value.completedAt === "string" ? { completedAt: value.completedAt } : {}) };
}
/** 校验并规范化「validateAnnotationReferences」输入，非法数据直接返回明确错误。 */
function validateAnnotationReferences(experiment: ExperimentRecordV2, understanding: UnderstandingAnnotationFacts, planning: PlanningAnnotationFacts, output: OutputAnnotationFacts): void {
  const worksheet = experiment.annotationWorksheet;
  if (!worksheet) throw new ApiProblemError(409, "WORKSHEET_NOT_READY", "请先生成标注题目", true);
  const variants = new Set(experiment.tests.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.testId));
  const expectedRequirements = new Map(worksheet.requirements.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => [item.requirementId, item]));
  const requirements = new Set(understanding.requirements.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.requirementId));
  if (understanding.requirements.length !== worksheet.requirements.length || understanding.requirements.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => {
    const expected = expectedRequirements.get(item.requirementId);
    return !expected || expected.label !== item.label || expected.weight !== item.weight;
  })) throw validation("理解题目与当前标注工作表不一致");
  if ([...understanding.marks, ...planning.marks, ...output.marks].some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => !variants.has(item.variantId))) throw validation("注释引用了未知 lane");
  if (understanding.marks.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => !requirements.has(item.requirementId))) throw validation("理解标记引用了未知需求");
  const expectedPlanning = new Set(worksheet.workflows.flatMap(/** 执行「expectedPlanning」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(item) => item.steps.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(step) => `${item.variantId}:${step.stepId}`)));
  const actualPlanning = planning.marks.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => `${item.variantId}:${item.stepId}`);
  if (new Set(actualPlanning).size !== actualPlanning.length || actualPlanning.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(key) => !expectedPlanning.has(key)) || (planning.completedAt && actualPlanning.length !== expectedPlanning.size)) throw validation("工作流标记与当前标注工作表不一致");
  const expectedOutput = new Map(worksheet.outputSections.flatMap(/** 执行「expectedOutput」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(item) => item.sections.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(section) => [`${item.variantId}:${section.answerSectionId}`, section])));
  const actualOutput = output.marks.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => `${item.variantId}:${item.answerSectionId}`);
  if (new Set(actualOutput).size !== actualOutput.length || actualOutput.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(key) => !expectedOutput.has(key)) || (output.completedAt && actualOutput.length !== expectedOutput.size)) throw validation("输出标记与当前标注工作表不一致");
  for (const mark of output.marks) {
    const answer = experiment.runs.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(run) => run.testId === mark.variantId)?.answerTexts.join("\n") ?? "";
    const quoted = answer.slice(mark.start, mark.end);
    const expected = expectedOutput.get(`${mark.variantId}:${mark.answerSectionId}`);
    if (!expected || mark.start !== expected.start || mark.end !== expected.end || mark.quotedTextHash !== expected.quotedTextHash || mark.start < 0 || mark.end <= mark.start || mark.end > answer.length || sha256(quoted) !== mark.quotedTextHash) throw validation("输出标记范围或 quotedTextHash 无效");
  }
}
/** 执行「rubric」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function rubric(): ExperimentScorecard["rubric"] { return {
  rubricId: "context_experiment_four_dimensions", rubricVersion: 1,
  dimensions: [
    { id: "understanding", source: "manual_annotation", weight: 0.25 },
    { id: "planning", source: "manual_annotation", weight: 0.25 },
    { id: "output", source: "manual_annotation", weight: 0.25 },
    { id: "execution", source: "runtime_metrics", weight: 0.25 },
  ], executionPolicy: { policyId: "runtime_execution_v1", policyVersion: 1 },
}; }
/** 根据已校验输入构建「makeRanking」结果，不额外持有调用方的大对象。 */
function makeRanking(values: Array<{ variantId: string; totalScore: number }>): Array<{ rank: number; variantIds: string[]; totalScore: number }> {
  const scores = [...new Set(values.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.totalScore))].toSorted(/** 执行「scores」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(a, b) => b - a);
  return scores.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(score, index) => ({ rank: index + 1, variantIds: values.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.totalScore === score).map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.variantId), totalScore: score }));
}
/** 执行「validation」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function validation(message: string): ApiProblemError { return new ApiProblemError(400, "VALIDATION_FAILED", message, false); }
/** 执行「sha256」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
/** 更新「record」对应状态，并保持写入顺序、原子性与容量约束。 */
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
/** 执行「publicMessage」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function publicMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
/** 执行「legacyReadOnly」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function legacyReadOnly(): ApiProblemError {
  return new ApiProblemError(409, "LEGACY_EXPERIMENT_READ_ONLY", "旧版实验仅支持只读查看", false);
}
/** 校验并取得「requiredMetric」所需对象；缺失或归属不符时立即抛出明确错误。 */
function requiredMetric(value: number | undefined, field: string): number {
  if (value === undefined || !Number.isFinite(value)) {
    throw new ApiProblemError(409, "EXECUTION_METRICS_UNAVAILABLE", `执行指标不可用: ${field}`, false);
  }
  return value;
}
/** 执行「snapshotFromPreview」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function snapshotFromPreview(
  test: import("@kindergarten/contracts").ExperimentTestDraftV2,
  preview: import("@kindergarten/contracts").ContextPreviewResponseV2,
  frozenAt: string,
): ExperimentTestSnapshotV2 {
  const system = preview.contextSummary.items.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.kind === "system_instruction")?.raw?.value ?? "";
  return {
    snapshotId: randomUUID(),
    testId: test.testId,
    label: test.label,
    sourceAgent: structuredClone(test.sourceAgent),
    policy: structuredClone(test.policy),
    agentSnapshotHash: preview.agentSnapshotHash,
    model: {
      modelStudentId: preview.model.modelStudentId,
      providerKind: preview.model.providerKind,
      model: preview.model.model,
      capabilityHash: preview.capabilityHash,
      ...(preview.model.contextWindowTokens === undefined ? {} : { contextWindowTokens: preview.model.contextWindowTokens }),
    },
    reasoning: structuredClone(preview.resolvedReasoning),
    dependencies: [
      ...test.policy.skillInstallationIds.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(id) => ({ kind: "skill" as const, id, contentHash: sha256(stableJson({ id, capabilityHash: preview.capabilityHash })) })),
      ...test.policy.mcps.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.enabled).map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => ({ kind: "mcp" as const, id: item.mcpInstallationId, contentHash: sha256(stableJson({ item, capabilityHash: preview.capabilityHash })) })),
    ],
    runtimePrompt: { version: "runtime_system_prompt_v1", hash: sha256(system) },
    firstRequestPreview: {
      contextHash: sha256(stableJson(preview.contextSummary)),
      providerInputHash: preview.providerInputHash,
      providerInputBytes: preview.providerInputBytes,
      estimatedTokens: preview.contextSummary.totalEstimatedTokens,
      actualHistoryTurns: 0,
    },
    effectiveConfigurationHash: preview.effectiveConfigurationHash,
    frozenAt,
  };
}
/** 执行「runtimeFactsFromTurn」主流程，传播取消与失败并在结束时清理临时资源。 */
function runtimeFactsFromTurn(turn: import("../repository/session-types.js").TurnExecutionRecord): import("@kindergarten/contracts").ExperimentRunRuntimeFacts {
  const firstRound = turn.modelRounds?.[0];
  return {
    ...(turn.agentSnapshotHash ? { agentSnapshotHash: turn.agentSnapshotHash } : {}),
    capabilityGenerations: turn.capabilitySnapshots?.length ?? 0,
    capabilityToolNames: [...new Set(turn.capabilitySnapshots?.flatMap(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(item) => item.snapshot.tools.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(tool) => tool.modelName)) ?? [])],
    contextSources: firstRound?.contextSummary.items.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => ({ kind: item.kind, title: item.title, estimatedTokens: item.estimatedTokens, ...(item.kind === "truncated_history" ? { truncated: true } : {}) })) ?? [],
    ...(turn.modelRounds ? { modelRounds: turn.modelRounds.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(round) => ({
      roundIndex: round.roundIndex,
      capabilityGeneration: round.capabilityGeneration,
      contextSummary: structuredClone(round.contextSummary),
      ...(round.providerInput ? { providerInput: structuredClone(round.providerInput) } : {}),
      ...(round.providerInputHash
        ? { providerInputHash: round.providerInputHash }
        : round.providerInput ? { providerInputHash: createHash("sha256").update(round.providerInput.value).digest("hex") } : {}),
      ...(round.providerInputBytes !== undefined
        ? { providerInputBytes: round.providerInputBytes }
        : round.providerInput ? { providerInputBytes: Buffer.byteLength(round.providerInput.value) } : {}),
      ...(round.resolvedReasoning ? { resolvedReasoning: structuredClone(round.resolvedReasoning) } : {}),
    })) } : {}),
    ...(firstRound?.providerInputHash
      ? { providerInputHash: firstRound.providerInputHash }
      : firstRound?.providerInput ? { providerInputHash: createHash("sha256").update(firstRound.providerInput.value).digest("hex") } : {}),
    ...(firstRound?.providerInputBytes !== undefined
      ? { providerInputBytes: firstRound.providerInputBytes }
      : firstRound?.providerInput ? { providerInputBytes: Buffer.byteLength(firstRound.providerInput.value) } : {}),
    ...(turn.usage ? { usage: turn.usage } : {}),
    ...(turn.stopReason ? { stopReason: turn.stopReason } : {}),
  };
}
