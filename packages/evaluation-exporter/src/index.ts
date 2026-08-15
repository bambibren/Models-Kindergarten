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

/**
 * 把 Runtime 的同步观察事件收集成一个终态文档，再异步发送到独立服务。
 * 网络失败只影响评测可用性，不能反向改变 Agent 的执行结果。
 */
export class EvaluationTraceExporter implements RuntimeObservationSink {
  private readonly pending = new Map<string, PendingTrace>();
  private readonly uploads = new Set<Promise<void>>();
  private readonly endpoint: URL;
  private readonly completed = new Map<string, TurnTraceDocument>();

  constructor(
    baseUrl: string,
    private readonly fetcher: FetchLike = fetch,
  ) {
    this.endpoint = new URL("/api/v1/turn-evaluations", ensureTrailingSlash(baseUrl));
  }

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
        signature: event.signature,
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
      schemaVersion: 1,
      ...trace,
      status: event.status,
      ...(event.stopReason ? { stopReason: event.stopReason } : {}),
      completedAt: event.completedAt,
    };
    this.completed.set(turnKey(document.sessionId, document.turnId), structuredClone(document));
    const upload = this.upload(document).finally(() => this.uploads.delete(upload));
    this.uploads.add(upload);
  }

  /** 测试和进程关闭时可等待在途上传；正常 Prompt 不等待这个 Promise。 */
  async flush(): Promise<void> {
    await Promise.all([...this.uploads]);
  }

  trace(sessionId: string, turnId: string): TurnTraceDocument | undefined {
    const value = this.completed.get(turnKey(sessionId, turnId));
    return value ? structuredClone(value) : undefined;
  }

  private async upload(document: TurnTraceDocument): Promise<void> {
    try {
      const response = await this.fetcher(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(document),
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

function turnKey(sessionId: string, turnId: string): string {
  return `${sessionId}\u0000${turnId}`;
}

function findRound(trace: PendingTrace, roundId: string): ModelRoundTrace | undefined {
  return trace.modelRounds.find((item) => item.id === roundId);
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
