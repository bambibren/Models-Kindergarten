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
  type VariantFourDimensionScore,
} from "@kindergarten/contracts";
import type { AgentService } from "../agent/agent-service.js";
import type { SessionRepository } from "../repository/session-repository.js";
import type { SessionEntry } from "../repository/session-types.js";
import { ApiProblemError } from "../server/api-problem.js";
import type { ModelStudentCatalog } from "../model/model-student-catalog.js";
import type { ExperimentRepository } from "./experiment-repository.js";
import type { EvaluationAccess } from "../evaluation/evaluation-module.js";
import type { ScoreResultUpsertInput } from "@kindergarten/evaluation-contract";
import type { AnnotationWorksheetGenerator, WorksheetRunEvidence } from "./annotation-worksheet-generator.js";
import type { ContextPreviewService } from "./context-preview-service.js";
import { EXPERIMENT_CONFIG, type ExperimentConfig } from "./experiment-config.js";

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
    private readonly config: ExperimentConfig = EXPERIMENT_CONFIG,
  ) {}

  /** 根据已校验输入构建「create」结果，不额外持有调用方的大对象。 */
async create(raw: unknown, ownerId = "local-admin"): Promise<ExperimentRecordV2> {
    let input;
    try { input = parseExperimentDraftV2(raw); }
    catch (error) { throw new ApiProblemError(400, "VALIDATION_FAILED", publicMessage(error), false); }
    const worksheetModelStudentId = this.configuredWorksheetModelStudentId(ownerId);
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
      worksheetModelStudentId,
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
    const worksheetModelStudentId = this.configuredWorksheetModelStudentId(ownerId);
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
        worksheetModelStudentId,
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
async binding(experimentId: string, testId: string, ownerId?: string): Promise<{ modelStudentId: string; agentId: string; experimentReasoning: import("@kindergarten/contracts").ResolvedReasoningSnapshot } | undefined> {
    const experiment = await this.repository.get(experimentId);
    if (!experiment || (ownerId && experiment.ownerId !== ownerId) || experiment.schemaVersion !== 2 || !["prepared", "running"].includes(experiment.status)) return undefined;
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
    await this.evaluation.removeScoreResultsBySource({ kind: "context_experiment", experimentId });
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
    const parsedOutput = parseOutput(raw.output);
    const artifactVariantIds = await this.outputArtifactVariantIds(experiment);
    const artifactVariants = new Set(artifactVariantIds);
    const output: OutputAnnotationFacts = {
      ...parsedOutput,
      // 旧评分可能保留了产物 lane 的文字标注；从现在起该 lane 只接受产物分。
      marks: parsedOutput.marks.filter((mark) => !artifactVariants.has(mark.variantId)),
    };
    validateAnnotationReferences(experiment, understanding, planning, output, artifactVariants);
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
      output: {
        ...output,
        artifactVariantIds,
        answers: experiment.runs.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(run) => ({ variantId: run.testId, text: run.answerTexts.join("\n") })),
      },
    });
    const current = await this.repository.getScorecard(experimentId);
    const scorecardId = current?.scorecardId ?? randomUUID();
    const variants = execution.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => {
      const dimensions = manual.byVariant[item.variantId] ?? {};
      const complete = manual.complete && dimensions.understanding !== undefined && dimensions.planning !== undefined && dimensions.output !== undefined;
      const source = { kind: "context_experiment", experimentId, testId: item.variantId, scorecardId } as const;
      return {
        variantId: item.variantId,
        scoreResultId: this.evaluation.scoreResultId(source),
        dimensionScores: { ...dimensions, execution: item.score },
        executionEvidence: { metrics: item.metrics, componentScores: item.components },
        ...(complete ? { totalScore: Math.round((dimensions.understanding! + dimensions.planning! + dimensions.output! + item.score) / 4) } : {}),
      };
    });
    const complete = manual.complete && variants.every(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.totalScore !== undefined);
    const ranking = complete ? makeRanking(variants.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => ({ variantId: item.variantId, totalScore: item.totalScore! }))) : undefined;
    const now = new Date().toISOString();
    const scorecard: ExperimentScorecard = {
      schemaVersion: 1,
      scorecardId,
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
    for (const variant of variants) {
      const snapshot = experiment.snapshots?.find((item) => item.testId === variant.variantId);
      if (!snapshot) throw new ApiProblemError(409, "SCORECARD_INCOMPLETE", `Test ${variant.variantId} 缺少冻结配置`, false);
      await this.evaluation.putScoreResult(experimentScoreResultInput(experiment, scorecard, snapshot, variant));
    }
    return scorecard;
  }

  /** 只把本次 Turn 成功发布或回滚后返回的 Artifact 链接视为该 lane 的产物。 */
private async outputArtifactVariantIds(experiment: ExperimentRecordV2): Promise<string[]> {
    const matches = await Promise.all(experiment.runs.map(async (run) => {
      if (!run.acpSessionId || !run.turnId) return false;
      const turnId = run.turnId;
      const session = await this.sessions.get(run.acpSessionId);
      return session.sessionEntries.some((entry) => isPublishedArtifactEntry(entry, turnId));
    }));
    return experiment.runs.flatMap((run, index) => matches[index] ? [run.testId] : []);
  }

  /** 执行「scorecard」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
  async scorecard(experimentId: string, ownerId = "local-admin"): Promise<ExperimentScorecard | undefined> {
    await this.get(experimentId, ownerId);
    return this.repository.getScorecard(experimentId);
  }

  /** 为已有 V2 scorecard 补齐每个 lane 的原子评分；V1 无冻结配置时不做推断。 */
  async reconcileScoreResults(): Promise<void> {
    const experiments = new Map((await this.repository.list())
      .filter((item): item is ExperimentRecordV2 => item.schemaVersion === 2)
      .map((item) => [item.experimentId, item]));
    for (const current of await this.repository.listScorecards()) {
      const experiment = experiments.get(current.experimentId);
      if (!experiment?.snapshots) continue;
      try {
        const variants = current.variants.map((variant) => ({
          ...variant,
          scoreResultId: this.evaluation.scoreResultId({
            kind: "context_experiment",
            experimentId: experiment.experimentId,
            testId: variant.variantId,
            scorecardId: current.scorecardId,
          }),
        }));
        const scorecard = { ...current, variants };
        for (const variant of variants) {
          const snapshot = experiment.snapshots.find((item) => item.testId === variant.variantId);
          if (!snapshot) throw new Error(`Test ${variant.variantId} 缺少冻结配置`);
          await this.evaluation.putScoreResult(experimentScoreResultInput(experiment, scorecard, snapshot, variant));
        }
        if (variants.some((variant, index) => variant.scoreResultId !== current.variants[index]?.scoreResultId)) {
          await this.repository.putScorecard(scorecard);
        }
      } catch (error) {
        console.warn(`Experiment ${current.experimentId} 原子评分迁移已跳过：${publicMessage(error)}`);
      }
    }
  }

  /** 执行「generateAnnotationWorksheet」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async generateAnnotationWorksheet(experimentId: string, force = false, ownerId = "local-admin") {
    const experiment = await this.getV2(experimentId, ownerId);
    const selectedModelStudentId = this.configuredWorksheetModelStudentId(ownerId);
    const replacingModel = selectedModelStudentId !== experiment.worksheetModelStudentId;
    if (experiment.annotationWorksheet && !force && !replacingModel) return experiment.annotationWorksheet;
    if (!this.models.isReady(selectedModelStudentId, ownerId)) {
      throw new ApiProblemError(409, "EXPERIMENT_NOT_RUNNABLE", "所选评测辅助 ModelStudent 不可用", false);
    }
    if (!this.worksheetGenerator) throw new ApiProblemError(503, "WORKSHEET_GENERATOR_UNAVAILABLE", "标注题目生成器不可用", true);
    if (!experiment.runs.every(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(run) => run.status === "completed")) {
      throw new ApiProblemError(409, "WORKSHEET_NOT_READY", "所有 lane 完成后才能生成标注题目", true);
    }
    const evidence = [];
    for (const run of experiment.runs) {
      let modelOutputs: WorksheetRunEvidence["modelOutputs"] = run.answerTexts.map((text) => ({ kind: "answer", text }));
      let firstThought: string | undefined;
      if (run.acpSessionId && run.turnId) {
        const session = await this.sessions.get(run.acpSessionId).catch(/** 评测材料缺失时仍可使用 Experiment 中已保存的回答。 */
() => undefined);
        const firstThoughtEntry = session?.sessionEntries.find(/** 理解题目只取该实验 Turn 的第一条有效思考，不回退到正文或其他 Turn。 */
(entry) => entry.turnId === run.turnId && entry.type === "thought" && Boolean(entry.text.trim()));
        if (firstThoughtEntry?.type === "thought") firstThought = firstThoughtEntry.text;
        const observed = session?.sessionEntries.flatMap<WorksheetRunEvidence["modelOutputs"][number]>((entry) => {
          if (entry.turnId !== run.turnId) return [];
          if (entry.type === "thought") return [{ kind: "thought" as const, text: entry.text }];
          if (entry.type === "message" && entry.role === "assistant") return [{ kind: "answer" as const, text: entry.text }];
          return [];
        }) ?? [];
        if (observed.length > 0) modelOutputs = observed;
      }
      evidence.push({
        variantId: run.testId,
        label: experiment.tests.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.testId === run.testId)?.label ?? run.testId,
        answer: run.answerTexts.join("\n"),
        ...(firstThought ? { firstThought } : {}),
        modelOutputs,
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
        modelRequests: trace.modelRounds.reduce(
          (total, round) => total + (round.attempts?.length ?? 1),
          0,
        ),
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
    for (const [index, test] of input.tests.entries()) {
      if (!this.models.isReady(test.modelStudentId, ownerId)) {
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

  /** 按服务端配置解析账号内唯一 Ready ModelStudent，避免浏览器覆盖工作表生成模型。 */
  private configuredWorksheetModelStudentId(ownerId: string): string {
    const matches = this.models.all(ownerId).filter((item) =>
      item.status === "ready" && item.displayName === this.config.worksheetModelDisplayName);
    if (matches.length !== 1) {
      throw new ApiProblemError(
        409,
        "EXPERIMENT_NOT_RUNNABLE",
        `评测辅助模型配置“${this.config.worksheetModelDisplayName}”必须对应当前账号下唯一 Ready ModelStudent`,
        false,
      );
    }
    return matches[0]!.modelStudentId;
  }
}

const ARTIFACT_OUTPUT_TOOLS = new Set(["publish_artifact", "publish_artifact_version", "rollback_artifact"]);

/** 工具完成且返回真实 artifact:// ResourceLink 时，才认定该 Turn 产生了可评分产物。 */
function isPublishedArtifactEntry(entry: SessionEntry, turnId: string): boolean {
  if (entry.type !== "tool_call" || entry.turnId !== turnId || entry.status !== "completed" ||
    (entry.outcomeStatus !== undefined && entry.outcomeStatus !== "success") || !ARTIFACT_OUTPUT_TOOLS.has(entry.name)) return false;
  return entry.content.some((item) => item.type === "content" && item.content.type === "resource_link" && item.content.uri.startsWith("artifact://"));
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
  if (!record(value) || !Array.isArray(value.scores)) throw validation("规划评分格式无效");
  return { scores: value.scores.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => {
    if (!record(item) || typeof item.variantId !== "string" || typeof item.score !== "number" ||
      !Number.isInteger(item.score) || item.score < 0 || item.score > 100) throw validation("规划评分必须是 0 到 100 的整数");
    return { variantId: item.variantId, score: item.score };
  }), ...(typeof value.completedAt === "string" ? { completedAt: value.completedAt } : {}) };
}
/** 校验并规范化「parseOutput」输入，非法数据直接返回明确错误。 */
function parseOutput(value: unknown): OutputAnnotationFacts {
  if (!record(value) || !Array.isArray(value.marks)) throw validation("输出注释格式无效");
  if (value.artifactScores !== undefined && !Array.isArray(value.artifactScores)) throw validation("产物评分格式无效");
  const artifactScores = (value.artifactScores ?? []).map((item) => {
    if (!record(item) || typeof item.variantId !== "string" || typeof item.score !== "number" ||
      !Number.isInteger(item.score) || item.score < 0 || item.score > 100) throw validation("产物评分必须是 0 到 100 的整数");
    return { variantId: item.variantId, score: item.score };
  });
  return { marks: value.marks.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => {
    if (!record(item) || typeof item.variantId !== "string" || typeof item.answerSectionId !== "string" || typeof item.start !== "number" || typeof item.end !== "number" ||
      !["effective", "partial", "none"].includes(String(item.verdict)) || typeof item.quotedTextHash !== "string" ||
      (item.markId !== undefined && typeof item.markId !== "string")) throw validation("输出标记格式无效");
    return {
      ...(typeof item.markId === "string" ? { markId: item.markId } : {}),
      variantId: item.variantId,
      answerSectionId: item.answerSectionId,
      start: item.start,
      end: item.end,
      verdict: item.verdict as "effective" | "partial" | "none",
      quotedTextHash: item.quotedTextHash,
    };
  }), ...(value.artifactScores !== undefined ? { artifactScores } : {}), ...(typeof value.completedAt === "string" ? { completedAt: value.completedAt } : {}) };
}
/** 校验并规范化「validateAnnotationReferences」输入，非法数据直接返回明确错误。 */
function validateAnnotationReferences(
  experiment: ExperimentRecordV2,
  understanding: UnderstandingAnnotationFacts,
  planning: PlanningAnnotationFacts,
  output: OutputAnnotationFacts,
  artifactVariants = new Set<string>(),
): void {
  const worksheet = experiment.annotationWorksheet;
  if (!worksheet) throw new ApiProblemError(409, "WORKSHEET_NOT_READY", "请先生成标注题目", true);
  const variants = new Set(experiment.tests.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.testId));
  const expectedRequirements = new Map(worksheet.requirements.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => [item.requirementId, item]));
  const requirements = new Set(understanding.requirements.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.requirementId));
  if (requirements.size !== understanding.requirements.length || understanding.requirements.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => {
    const expected = expectedRequirements.get(item.requirementId);
    if (item.requirementId === "manual-other") return item.label !== "其他需求";
    return !expected || expected.label !== item.label;
  }) || (understanding.completedAt && understanding.requirements.length === 0)) throw validation("理解题目与当前标注工作表不一致");
  if ([...understanding.marks, ...planning.scores, ...output.marks, ...(output.artifactScores ?? [])].some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => !variants.has(item.variantId))) throw validation("注释引用了未知 lane");
  const planningScoreVariants = planning.scores.map((item) => item.variantId);
  if (new Set(planningScoreVariants).size !== planningScoreVariants.length ||
    (planning.completedAt && planningScoreVariants.length !== variants.size)) throw validation("规划评分与当前 lane 不一致");
  const artifactScoreVariants = (output.artifactScores ?? []).map((item) => item.variantId);
  if (new Set(artifactScoreVariants).size !== artifactScoreVariants.length || artifactScoreVariants.some((variantId) => !artifactVariants.has(variantId))) {
    throw validation("产物评分与当前 lane 的发布事实不一致");
  }
  if (understanding.marks.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => !requirements.has(item.requirementId))) throw validation("理解标记引用了未知需求");
  const actualUnderstanding = understanding.marks.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => `${item.variantId}:${item.requirementId}`);
  if (new Set(actualUnderstanding).size !== actualUnderstanding.length ||
    (understanding.completedAt && actualUnderstanding.length !== variants.size * requirements.size)) throw validation("理解标记与当前候选需求不一致");
  const expectedOutput = new Map(worksheet.outputSections.flatMap(/** 执行「expectedOutput」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(item) => item.sections.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(section) => [`${item.variantId}:${section.answerSectionId}`, section])));
  const actualOutput = output.marks.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => `${item.variantId}:${item.answerSectionId}`);
  const markIds = output.marks.flatMap(/** 执行「markIds」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(item) => item.markId ? [`${item.variantId}:${item.markId}`] : []);
  const intervals = output.marks.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => `${item.variantId}:${item.start}:${item.end}`);
  if (actualOutput.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(key) => !expectedOutput.has(key)) || new Set(markIds).size !== markIds.length || new Set(intervals).size !== intervals.length) throw validation("输出标记与当前标注工作表不一致");
  for (const mark of output.marks) {
    const answer = experiment.runs.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(run) => run.testId === mark.variantId)?.answerTexts.join("\n") ?? "";
    const quoted = answer.slice(mark.start, mark.end);
    const expected = expectedOutput.get(`${mark.variantId}:${mark.answerSectionId}`);
    if (!expected || !Number.isInteger(mark.start) || !Number.isInteger(mark.end) || mark.start < expected.start || mark.end > expected.end ||
      mark.start < 0 || mark.end <= mark.start || mark.end > answer.length || sha256(quoted) !== mark.quotedTextHash) throw validation("输出标记范围或 quotedTextHash 无效");
  }
  for (const variantId of variants) {
    const ranges = output.marks.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.variantId === variantId).toSorted(/** 执行「ranges」主流程，传播取消与失败并在结束时清理临时资源。 */
(left, right) => left.start - right.start || left.end - right.end);
    if (ranges.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item, index) => index > 0 && item.start < ranges[index - 1]!.end)) throw validation("输出标记范围不能重叠");
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

/** 将实验 lane 的冻结快照和四维分投影为独立原子评分，不读取当前 Agent 配置。 */
function experimentScoreResultInput(
  experiment: ExperimentRecordV2,
  scorecard: ExperimentScorecard,
  snapshot: ExperimentTestSnapshotV2,
  variant: VariantFourDimensionScore,
): ScoreResultUpsertInput {
  return {
    ownerId: experiment.ownerId,
    modelStudentId: snapshot.model.modelStudentId,
    source: {
      kind: "context_experiment",
      experimentId: experiment.experimentId,
      testId: snapshot.testId,
      scorecardId: scorecard.scorecardId,
    },
    sourceTitle: `${experiment.name} · Test ${snapshot.label}`,
    agentConfiguration: {
      agentSnapshotHash: snapshot.agentSnapshotHash,
      agentId: snapshot.sourceAgent.agentId,
      agentName: snapshot.sourceAgent.name,
      systemPrompt: snapshot.policy.systemPrompt,
      builtinTools: structuredClone(snapshot.policy.builtinTools),
      builtinSkills: snapshot.policy.builtinSkillIds.map((skillId) => ({ skillId, enabled: true })),
      skills: snapshot.policy.skillInstallationIds.map((skillInstallationId) => ({ skillInstallationId, enabled: true })),
      mcps: structuredClone(snapshot.policy.mcps),
      historyPolicy: structuredClone(snapshot.policy.historyPolicy),
      memoryPolicy: structuredClone(snapshot.policy.memoryPolicy),
      reasoning: structuredClone(snapshot.reasoning),
    },
    dimensionScores: structuredClone(variant.dimensionScores),
    completed: scorecard.status === "complete" && variant.totalScore !== undefined,
    recordedAt: scorecard.updatedAt,
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
