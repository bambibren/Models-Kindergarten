import type {
  ModelAgentScoreGroupDetail,
  ModelAgentScoreGroupSummary,
  ScoreResultRecord,
  ScoreResultSource,
  ScoreResultUpsertInput,
  TurnEffectScoreDraft,
  TurnEffectScoreRecord,
  TurnEvaluationRecord,
  TurnTraceDocument,
} from "@kindergarten/evaluation-contract";
import type {
  RuntimeObservationEvent,
  RuntimeObservationSink,
} from "@kindergarten/runtime-observation";
import { evaluateTurn } from "./evaluator.js";
import { EvaluationRepository } from "./repository.js";
import { TraceCollector } from "./trace-collector.js";
import { normalizeTurnTrace } from "./trace-migration.js";
import {
  aggregateModelScoreGroups,
  buildScoreResult,
  modelScoreGroupDetail,
  scoreResultIdForSource,
} from "./score-result.js";

const PUBLIC_PREFIX = "/api/evaluation/v1";

/** Experiment 只依赖读取、排空和短期 Trace，不依赖 Evaluation 的具体存储实现。 */
export interface EvaluationAccess {
  get(
    sessionId: string,
    turnId: string,
  ): Promise<Pick<TurnEvaluationRecord, "result"> | undefined>;
  flush(): Promise<void>;
  takeTrace(sessionId: string, turnId: string): TurnTraceDocument | undefined;
  scoreResultId(source: ScoreResultSource): string;
  putScoreResult(input: ScoreResultUpsertInput): Promise<ScoreResultRecord>;
  removeScoreResultsBySource(source: ScoreResultSource | { kind: "context_experiment"; experimentId: string }): Promise<void>;
}

/**
 * Evaluation 的进程内模块边界：接收 Runtime 观察、异步评分持久化并提供只读查询。
 * 模块不可用时 Agent 仍可运行，只有评测读取和 Experiment 指标降级。
 */
export class EvaluationModule implements RuntimeObservationSink, EvaluationAccess {
  private readonly repository: EvaluationRepository;
  private readonly collector: TraceCollector;
  private initialized = false;
  private initializationError: string | undefined;

  constructor(dataDir: string) {
    this.repository = new EvaluationRepository(dataDir);
    this.collector = new TraceCollector(async (document) => {
      if (!this.initialized) throw new Error(this.initializationError ?? "Evaluation 尚未初始化");
      const trace = normalizeTurnTrace(document);
      await this.repository.put({
        schemaVersion: 2,
        trace,
        result: evaluateTurn(trace),
        createdAt: new Date().toISOString(),
      });
    });
  }

  /** 初始化失败只把 Evaluation 标为不可用，不阻止 Remote 主链启动。 */
  async initialize(): Promise<void> {
    try {
      await this.repository.initialize();
      this.initialized = true;
      this.initializationError = undefined;
    } catch (error) {
      this.initialized = false;
      this.initializationError = errorText(error);
      console.warn(`Evaluation 初始化失败，评测能力已降级：${this.initializationError}`);
    }
  }

  get available(): boolean {
    return this.initialized && this.repository.ready;
  }

  emit(event: RuntimeObservationEvent): void {
    this.collector.emit(event);
  }

  async flush(): Promise<void> {
    await this.collector.flush();
  }

  takeTrace(sessionId: string, turnId: string): TurnTraceDocument | undefined {
    return this.collector.takeTrace(sessionId, turnId);
  }

  async get(sessionId: string, turnId: string): Promise<TurnEvaluationRecord | undefined> {
    if (!this.available) return undefined;
    return this.repository.get(sessionId, turnId);
  }

  /** 读取独立人工效果分；Evaluation 不可用时与只读客观记录保持一致。 */
  async getEffectScore(sessionId: string, turnId: string): Promise<TurnEffectScoreRecord | undefined> {
    if (!this.available) return undefined;
    return this.repository.getEffectScore(sessionId, turnId);
  }

  /** 根据来源事实生成稳定 ID，页面 URL 与评分文件位置不再互相耦合。 */
  scoreResultId(source: ScoreResultSource): string {
    return scoreResultIdForSource(source);
  }

  /** 幂等写入一条原子评分，首次创建时间在重复保存时保持不变。 */
  async putScoreResult(input: ScoreResultUpsertInput): Promise<ScoreResultRecord> {
    if (!this.available) throw new Error("Evaluation 模块暂不可用");
    const id = scoreResultIdForSource(input.source);
    const record = buildScoreResult(input, await this.repository.getScoreResult(id));
    await this.repository.putScoreResult(record);
    return record;
  }

  /** 按账号读取原子评分，跨账号时与不存在保持相同结果。 */
  async getScoreResult(scoreResultId: string, ownerId: string): Promise<ScoreResultRecord | undefined> {
    if (!this.available) return undefined;
    const record = await this.repository.getScoreResult(scoreResultId);
    return record?.ownerId === ownerId ? record : undefined;
  }

  /** 模型排行只聚合完整四维评分，不让草稿参与平均值。 */
  async modelScoreGroups(ownerId: string, modelStudentId: string): Promise<ModelAgentScoreGroupSummary[]> {
    if (!this.available) return [];
    return aggregateModelScoreGroups(await this.repository.listScoreResults(), ownerId, modelStudentId);
  }

  /** 配置详情返回冻结配置与逐条原子历史。 */
  async modelScoreGroup(
    ownerId: string,
    modelStudentId: string,
    configurationHash: string,
  ): Promise<ModelAgentScoreGroupDetail | undefined> {
    if (!this.available) return undefined;
    return modelScoreGroupDetail(await this.repository.listScoreResults(), ownerId, modelStudentId, configurationHash);
  }

  /** 删除来源事实时同步清除其原子评分，避免模型排行留下悬空回链。 */
  async removeScoreResultsBySource(
    source: ScoreResultSource | { kind: "context_experiment"; experimentId: string },
  ): Promise<void> {
    if (!this.available) return;
    await this.repository.removeScoreResultsBySource(source);
  }

  /** 保存人工标注并固化当时的客观执行分，不修改 Runtime Trace。 */
  async putEffectScore(
    sessionId: string,
    turnId: string,
    draft: TurnEffectScoreDraft,
    executionScore: number,
    scoreInput: Omit<ScoreResultUpsertInput, "dimensionScores" | "completed" | "recordedAt">,
  ): Promise<TurnEffectScoreRecord> {
    if (!this.available) throw new Error("Evaluation 模块暂不可用");
    const savedAt = new Date().toISOString();
    const dimensions = effectScoreDimensions(draft, executionScore);
    const atom = await this.putScoreResult({
      ...scoreInput,
      dimensionScores: dimensions,
      completed: draft.annotations.understanding.completed && draft.annotations.planning.completed && draft.annotations.output.completed,
      recordedAt: savedAt,
    });
    const record: TurnEffectScoreRecord = {
      ...structuredClone(draft),
      sessionId,
      turnId,
      scoreResultId: atom.scoreResultId,
      executionScore,
      savedAt,
    };
    await this.repository.putEffectScore(record);
    return record;
  }

  /** 为旧单轮评分补齐原子记录和关联 ID，并保留原始评分时间。 */
  async reconcileEffectScore(
    record: TurnEffectScoreRecord,
    scoreInput: Omit<ScoreResultUpsertInput, "dimensionScores" | "completed" | "recordedAt">,
  ): Promise<void> {
    if (!this.available) return;
    const atom = await this.putScoreResult({
      ...scoreInput,
      dimensionScores: effectScoreDimensions(record, record.executionScore),
      completed: record.annotations.understanding.completed && record.annotations.planning.completed && record.annotations.output.completed,
      recordedAt: record.savedAt,
    });
    if (record.scoreResultId === atom.scoreResultId) return;
    await this.repository.putEffectScore({ ...structuredClone(record), scoreResultId: atom.scoreResultId });
  }

  /** 仅供启动迁移读取旧人工评分，不作为浏览器列表接口。 */
  async effectScoresForReconciliation(): Promise<TurnEffectScoreRecord[]> {
    if (!this.available) return [];
    return this.repository.listEffectScores();
  }

  /** 浏览器沿用同源只读路径；评测写入只允许由 Runtime 观察链触发。 */
  async fetch(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (url.pathname !== PUBLIC_PREFIX && !url.pathname.startsWith(`${PUBLIC_PREFIX}/`)) {
      return undefined;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return Response.json({ error: "Evaluation 浏览器入口只允许读取" }, { status: 405 });
    }
    if (!this.available) {
      return Response.json({ error: "Evaluation 模块暂不可用" }, { status: 503 });
    }

    const match = url.pathname.match(
      /^\/api\/evaluation\/v1\/turn-evaluations\/([^/]+)\/([^/]+)$/,
    );
    if (!match?.[1] || !match[2]) return Response.json({ error: "Not Found" }, { status: 404 });
    const record = await this.repository.get(
      decodeURIComponent(match[1]),
      decodeURIComponent(match[2]),
    );
    if (!record) return Response.json({ error: "尚未生成本轮评测" }, { status: 404 });
    if (request.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    return Response.json(record);
  }
}

/** 单轮理解分由带权需求事实计算；规划和输出沿用已校验人工分。 */
function effectScoreDimensions(draft: TurnEffectScoreDraft, execution: number): ScoreResultRecord["dimensionScores"] {
  const requirements = draft.annotations.understanding.requirements;
  const totalWeight = requirements.reduce((sum, item) => sum + item.weight, 0);
  const metWeight = requirements.reduce((sum, item) => sum + (item.verdict === "met" ? item.weight : 0), 0);
  const understanding = totalWeight > 0 ? Math.round(100 * metWeight / totalWeight) : 0;
  return {
    understanding,
    ...(draft.annotations.planning.score === undefined ? {} : { planning: draft.annotations.planning.score }),
    output: draft.annotations.output.score,
    execution,
  };
}

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
