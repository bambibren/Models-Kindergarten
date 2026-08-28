import type {
  ModelRoundTrace,
  PermissionTrace,
  RuntimeErrorTrace,
  ToolCallTrace,
  TurnTraceDocument,
} from "@kindergarten/evaluation-contract";
import type {
  RuntimeObservationEvent,
  RuntimeObservationSink,
} from "@kindergarten/runtime-observation";

interface PendingTrace {
  traceId: string;
  runId: string;
  sessionId: string;
  turnId: string;
  variant: TurnTraceDocument["variant"];
  resolvedReasoning: TurnTraceDocument["resolvedReasoning"];
  startedAt: number;
  modelRounds: ModelRoundTrace[];
  toolCalls: ToolCallTrace[];
  permissions: PermissionTrace[];
  errors: RuntimeErrorTrace[];
}

type FetchLike = typeof fetch;
const MAX_COMPLETED_TRACES = 8;
const MAX_TRACE_BYTES = 1024 * 1024;
const MAX_CONCURRENT_UPLOADS = 4;

/**
 * 把 Runtime 的同步观察事件收集成一个终态文档，再异步发送到独立服务。
 * 网络失败只影响评测可用性，不能反向改变 Agent 的执行结果。
 */
export class EvaluationTraceExporter implements RuntimeObservationSink {
  private readonly pending = new Map<string, PendingTrace>();
  private readonly uploads = new Set<Promise<void>>();
  private readonly endpoint: URL;
  private readonly completed = new Map<string, TurnTraceDocument>();

  /** 初始化「EvaluationTraceExporter」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(
    baseUrl: string,
    private readonly fetcher: FetchLike = fetch,
  ) {
    this.endpoint = new URL("/api/v1/turn-evaluations", ensureTrailingSlash(baseUrl));
  }

  /** 按 runId 聚合有限 Observation；收到 Turn 终态后先删除 pending，再生成并上传 Trace V2。 */
emit(event: RuntimeObservationEvent): void {
    if (event.type === "turn_started") {
      this.pending.set(event.runId, {
        traceId: event.runId,
        runId: event.runId,
        sessionId: event.sessionId,
        turnId: event.turnId,
        variant: structuredClone(event.variant),
        resolvedReasoning: structuredClone(event.resolvedReasoning),
        startedAt: event.startedAt,
        modelRounds: [],
        toolCalls: [],
        permissions: [],
        errors: [],
      });
      return;
    }

    const trace = this.pending.get(event.runId);
    if (!trace) return;

    if (event.type === "model_round_started") {
      trace.modelRounds.push({
        id: event.roundId,
        index: event.index,
        startedAt: event.startedAt,
        resolvedReasoning: structuredClone(event.resolvedReasoning),
        context: structuredClone(event.context),
      });
      return;
    }
    if (event.type === "model_round_first_token") {
      const round = findRound(trace, event.roundId);
      if (round && round.firstTokenAt === undefined) round.firstTokenAt = event.at;
      return;
    }
    if (event.type === "model_round_usage") {
      const round = findRound(trace, event.roundId);
      if (!round) return;
      if (event.inputTokens !== undefined) round.context.inputTokens = event.inputTokens;
      if (event.outputTokens !== undefined) round.outputTokens = event.outputTokens;
      if (event.cachedInputTokens !== undefined) round.cachedInputTokens = event.cachedInputTokens;
      if (event.reasoningOutputTokens !== undefined) round.reasoningOutputTokens = event.reasoningOutputTokens;
      return;
    }
    if (event.type === "model_round_completed") {
      const round = findRound(trace, event.roundId);
      if (!round) return;
      round.completedAt = event.completedAt;
      round.stopReason = event.stopReason;
      round.output = structuredClone(event.output);
      return;
    }
    if (event.type === "tool_call_started") {
      trace.toolCalls.push({
        toolCallId: event.toolCallId,
        modelRoundId: event.roundId,
        name: event.name,
        arguments: structuredClone(event.arguments),
        signatureHash: event.signatureHash,
        permission: event.permission,
        startedAt: event.startedAt,
      });
      return;
    }
    if (event.type === "permission_decided") {
      trace.permissions.push({
        toolCallId: event.toolCallId,
        required: event.required,
        decision: event.decision,
        decidedAt: event.decidedAt,
      });
      return;
    }
    if (event.type === "tool_call_completed") {
      const call = trace.toolCalls.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.toolCallId === event.toolCallId);
      if (!call) return;
      call.status = event.status;
      call.completedAt = event.completedAt;
      if (event.error) call.error = structuredClone(event.error);
      if (event.output !== undefined) call.output = structuredClone(event.output);
      return;
    }
    if (event.type === "runtime_error") {
      trace.errors.push({ scope: event.scope, message: event.message, at: event.at });
      return;
    }
    if (event.type === "capability_generation_changed") return;

    this.pending.delete(event.runId);
    const document: TurnTraceDocument = {
      schemaVersion: 2,
      ...trace,
      status: event.status,
      ...(event.stopReason ? { stopReason: event.stopReason } : {}),
      completedAt: event.completedAt,
    };
    const serialized = JSON.stringify(document);
    if (new TextEncoder().encode(serialized).byteLength > MAX_TRACE_BYTES) {
      console.warn(`Turn Trace 超过 ${MAX_TRACE_BYTES} 字节，已丢弃评测副本：${document.sessionId}/${document.turnId}`);
      return;
    }
    this.rememberCompleted(document);
    if (this.uploads.size >= MAX_CONCURRENT_UPLOADS) {
      console.warn(
        `Turn 评测上传并发已达到 ${MAX_CONCURRENT_UPLOADS}，跳过非关键评测副本：${document.sessionId}/${document.turnId}`,
      );
      return;
    }
    const upload = this.upload(document, serialized).finally(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => this.uploads.delete(upload));
    this.uploads.add(upload);
  }

  /** 测试和进程关闭时可等待在途上传；正常 Prompt 不等待这个 Promise。 */
  async flush(): Promise<void> {
    await Promise.all([...this.uploads]);
  }

  /**
   * 本地 Trace 只用于 Evaluation Service 尚未可查时的短暂兜底。
   * 读取即转移所有权，避免实验完成后仍在 Remote 中重复常驻。
   */
  takeTrace(sessionId: string, turnId: string): TurnTraceDocument | undefined {
    const key = turnKey(sessionId, turnId);
    const value = this.completed.get(key);
    this.completed.delete(key);
    return value ? structuredClone(value) : undefined;
  }

  /** 维护最近 8 条本地兜底 Trace；重复键刷新顺序，超限删除最老记录。 */
private rememberCompleted(document: TurnTraceDocument): void {
    const key = turnKey(document.sessionId, document.turnId);
    this.completed.delete(key);
    this.completed.set(key, structuredClone(document));
    while (this.completed.size > MAX_COMPLETED_TRACES) {
      const oldest = this.completed.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.completed.delete(oldest);
    }
  }

  /** 在 3 秒超时内提交评测副本；失败只记录警告，不改变已经完成的 Agent Turn。 */
private async upload(document: TurnTraceDocument, serialized: string): Promise<void> {
    try {
      const response = await this.fetcher(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: serialized,
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      console.warn(
        `Turn 评测上传失败（${document.sessionId}/${document.turnId}）：${errorText(error)}`,
      );
    }
  }
}

/** 由规范字段生成稳定的「turnKey」标识，供索引精确定位且不保留原始大对象。 */
function turnKey(sessionId: string, turnId: string): string {
  return `${sessionId}\u0000${turnId}`;
}

/** 读取「findRound」所需数据，并遵守作用域、分页与容量边界。 */
function findRound(trace: PendingTrace, roundId: string): ModelRoundTrace | undefined {
  return trace.modelRounds.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.id === roundId);
}

/** 校验并取得「ensureTrailingSlash」所需对象；缺失或归属不符时立即抛出明确错误。 */
function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

/** 把未知异常转换为「errorText」文本，避免错误序列化过程再次抛出。 */
function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
