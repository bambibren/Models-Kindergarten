import type { ExecutionMetricsSnapshot, ExperimentRunRuntimeFacts } from "@kindergarten/contracts";
import type { TurnEvaluationRecord } from "@kindergarten/evaluation-contract";
import type { DemoExecution } from "../demo/agent-evaluation/types.js";

/** 正式实验页投影执行轨迹所需的最小 Run 事实。 */
export interface ExecutionTraceRun {
  variantId: string;
  status: string;
  executionMetrics?: ExecutionMetricsSnapshot;
  runtimeFacts?: ExperimentRunRuntimeFacts;
  error?: { message: string };
}

/** 把完整 Evaluation Trace 投影成 Demo 与正式页共用的执行摘要。 */
export function toDemoExecution(run: ExecutionTraceRun, evaluation: TurnEvaluationRecord | null | undefined): DemoExecution {
  const metrics = run.executionMetrics;
  const trace = evaluation?.trace;
  if (!trace) {
    const rounds = run.runtimeFacts?.modelRounds ?? [];
    return {
      score: 0,
      duration: metrics ? formatDuration(metrics.totalDurationMs) : "不可用",
      modelRounds: metrics?.modelRoundCount ?? rounds.length,
      retryCount: Math.max(0, (run.runtimeFacts?.usage?.modelRequests ?? rounds.length) - rounds.length),
      toolCalls: metrics?.toolCallCount ?? 0,
      outputTokens: metrics?.totalOutputTokens ?? 0,
      trace: [
        ...rounds.map((round) => ({
          id: `round:${round.roundIndex}`,
          round: round.roundIndex + 1,
          type: "model" as const,
          title: `模型轮次 ${round.roundIndex + 1}`,
          detail: `${round.contextSummary.items.length} 项上下文 · capability generation ${round.capabilityGeneration}`,
          duration: "不可用",
          status: "completed" as const,
        })),
        ...(run.status === "pending" ? [] : [{
          id: `result:${run.variantId}`,
          round: Math.max(1, rounds.length),
          type: "result" as const,
          title: run.status === "cancelled" ? "Prompt Turn 已取消" : "Prompt Turn 结束",
          detail: run.error?.message ?? `终止原因：${run.runtimeFacts?.stopReason ?? run.status}`,
          duration: metrics ? formatDuration(metrics.totalDurationMs) : "不可用",
          status: run.status === "cancelled" ? "cancelled" as const : run.status === "completed" ? "completed" as const : "failed" as const,
        }]),
      ],
    };
  }

  const roundById = new Map(trace.modelRounds.map((round) => [round.id, round.index + 1]));
  const modelEvents = trace.modelRounds.reduce<Array<{ at: number; item: DemoExecution["trace"][number] }>>((events, round) => {
    const attempts = round.attempts;
    if (!attempts?.length) {
      events.push({
        at: round.startedAt,
        item: {
          id: `round:${round.id}`,
          round: round.index + 1,
          type: "model",
          title: `模型轮次 ${round.index + 1}`,
          detail: `输入 ${round.context.inputTokens ?? "—"} tokens · 输出 ${round.outputTokens ?? "—"} tokens · ${round.stopReason ?? "未结束"}`,
          duration: durationBetween(round.startedAt, round.completedAt ?? trace.completedAt),
          status: round.stopReason === "cancelled" || trace.status === "cancelled" ? "cancelled" : round.completedAt ? "completed" : "failed",
        },
      });
      return events;
    }
    attempts.forEach((attempt, index) => events.push({
      at: attempt.startedAt,
      item: {
        id: `attempt:${round.id}:${attempt.id}`,
        round: round.index + 1,
        type: "model",
        title: `模型轮次 ${round.index + 1}`,
        detail: attempt.error
          ? `${attempt.error.code} · ${attempt.error.message}`
          : `模型请求完成${index === attempts.length - 1 ? ` · 轮次输出 ${round.outputTokens ?? "—"} tokens` : ""}`,
        duration: durationBetween(attempt.startedAt, attempt.completedAt ?? trace.completedAt),
        status: attempt.status === "completed" ? "completed" : attempt.status === "failed" ? "failed" : trace.status === "failed" ? "failed" : "cancelled",
        attemptIndex: attempt.index,
        ...(attempt.retryDelayMs === undefined ? {} : { retryDelay: formatDuration(attempt.retryDelayMs) }),
      },
    }));
    return events;
  }, []);

  const ordered = [
    ...modelEvents,
    ...trace.toolCalls.map((tool) => ({
      at: tool.startedAt,
      item: {
        id: `tool:${tool.toolCallId}`,
        round: roundById.get(tool.modelRoundId) ?? 1,
        type: "tool" as const,
        title: tool.name,
        detail: tool.error?.message ?? `参数 ${tool.arguments.bytes} bytes${tool.output ? ` · 输出 ${tool.output.bytes} bytes` : ""}`,
        duration: durationBetween(tool.startedAt, tool.completedAt ?? trace.completedAt),
        status: tool.status === "success" ? "completed" as const : tool.status ? "failed" as const : "cancelled" as const,
      },
    })),
    {
      at: trace.completedAt,
      item: {
        id: `result:${trace.turnId}`,
        round: Math.max(1, trace.modelRounds.length),
        type: "result" as const,
        title: trace.status === "completed" ? "Prompt Turn 完成" : trace.status === "cancelled" ? "Prompt Turn 已取消" : "Prompt Turn 失败",
        detail: trace.errors.map((error) => error.message).join("；") || `终止原因：${trace.stopReason ?? trace.status}`,
        duration: formatDuration(trace.completedAt - trace.startedAt),
        status: trace.status === "completed" ? "completed" as const : trace.status === "cancelled" ? "cancelled" as const : "failed" as const,
      },
    },
  ].toSorted((left, right) => left.at - right.at).map((event) => event.item);

  return {
    score: 0,
    duration: formatDuration(trace.completedAt - trace.startedAt),
    modelRounds: trace.modelRounds.length,
    retryCount: trace.modelRounds.reduce((sum, round) => sum + (round.attempts?.filter((attempt) => attempt.index > 0).length ?? 0), 0),
    toolCalls: trace.toolCalls.length,
    outputTokens: metrics?.totalOutputTokens ?? trace.modelRounds.reduce((sum, round) => sum + (round.outputTokens ?? 0), 0),
    trace: ordered,
  };
}

function durationBetween(startedAt: number, completedAt?: number): string {
  return completedAt === undefined ? "未完成" : formatDuration(Math.max(0, completedAt - startedAt));
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
}
