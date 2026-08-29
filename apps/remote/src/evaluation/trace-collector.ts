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

type SaveTrace = (document: TurnTraceDocument) => Promise<void>;

const MAX_COMPLETED_TRACES = 8;
const MAX_TRACE_BYTES = 1024 * 1024;
const MAX_CONCURRENT_WRITES = 4;

/**
 * 把 Runtime 观察事件组装成终态 Trace，再交给 Evaluation 模块异步保存。
 * 保存失败、容量限制和评测降级都不能反向改变已经完成的 Agent Turn。
 */
export class TraceCollector implements RuntimeObservationSink {
  private readonly pending = new Map<string, PendingTrace>();
  private readonly writes = new Set<Promise<void>>();
  private readonly completed = new Map<string, TurnTraceDocument>();

  constructor(private readonly save: SaveTrace) {}

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
      const call = trace.toolCalls.find((item) => item.toolCallId === event.toolCallId);
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
    if (this.writes.size >= MAX_CONCURRENT_WRITES) {
      console.warn(
        `Evaluation 写入并发已达到 ${MAX_CONCURRENT_WRITES}，跳过非关键评测副本：${document.sessionId}/${document.turnId}`,
      );
      return;
    }
    const write = this.persist(document).finally(() => this.writes.delete(write));
    this.writes.add(write);
  }

  /** 等待已经开始的评测写入；Agent Turn 正常流程不会等待。 */
  async flush(): Promise<void> {
    await Promise.all([...this.writes]);
  }

  /** 最近 Trace 只用于 Experiment 完成瞬间读取，读取后立即释放。 */
  takeTrace(sessionId: string, turnId: string): TurnTraceDocument | undefined {
    const key = turnKey(sessionId, turnId);
    const value = this.completed.get(key);
    this.completed.delete(key);
    return value ? structuredClone(value) : undefined;
  }

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

  private async persist(document: TurnTraceDocument): Promise<void> {
    try {
      await this.save(structuredClone(document));
    } catch (error) {
      console.warn(
        `Evaluation 写入失败（${document.sessionId}/${document.turnId}）：${errorText(error)}`,
      );
    }
  }
}

function turnKey(sessionId: string, turnId: string): string {
  return `${sessionId}\u0000${turnId}`;
}

function findRound(trace: PendingTrace, roundId: string): ModelRoundTrace | undefined {
  return trace.modelRounds.find((item) => item.id === roundId);
}

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
