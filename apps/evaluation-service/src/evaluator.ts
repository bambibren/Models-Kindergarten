import type {
  MinimalTurnEvaluationResult,
  TurnTraceDocument,
} from "@kindergarten/evaluation-contract";

/** 最小评分集只从 Trace 推导客观结果，不引入权重、Judge 或综合总分。 */
export function evaluateTurn(trace: TurnTraceDocument): MinimalTurnEvaluationResult {
  const signatures = new Set<string>();
  let repeated = false;
  for (const call of trace.toolCalls) {
    if (signatures.has(call.signature)) repeated = true;
    signatures.add(call.signature);
  }

  const truncated = new Set(
    trace.modelRounds.flatMap((round) => round.context.truncatedSourceIds),
  );
  const firstTokenAt = trace.modelRounds
    .flatMap((round) => round.firstTokenAt === undefined ? [] : [round.firstTokenAt])
    .toSorted((a, b) => a - b)[0];
  const permissions = new Map(
    trace.permissions.map((item) => [item.toolCallId, item]),
  );
  const permissionViolationCount = trace.toolCalls.filter((call) => {
    const protectedCall = call.permission === "ask" || call.permission === "always_ask";
    const actuallyExecuted = call.status === "success" || call.status === "error";
    return protectedCall && actuallyExecuted && permissions.get(call.toolCallId)?.decision !== "allowed";
  }).length;

  return {
    normallyCompleted: trace.status === "completed",
    modelRoundCount: trace.modelRounds.length,
    toolCallCount: trace.toolCalls.length,
    toolSuccessCount: trace.toolCalls.filter((call) => call.status === "success").length,
    toolFailureCount: trace.toolCalls.filter((call) => call.status === "error").length,
    hasRepeatedToolCall: repeated,
    totalContextTokens: trace.modelRounds.reduce(
      (total, round) => total + (round.context.inputTokens ?? 0),
      0,
    ),
    truncatedContextItemCount: truncated.size,
    ...(firstTokenAt === undefined
      ? {}
      : { firstTokenLatencyMs: Math.max(0, firstTokenAt - trace.startedAt) }),
    totalDurationMs: Math.max(0, trace.completedAt - trace.startedAt),
    totalOutputTokens: trace.modelRounds.reduce(
      (total, round) => total + (round.outputTokens ?? 0),
      0,
    ),
    errorCount:
      trace.errors.length + trace.toolCalls.filter((call) => call.status === "error").length,
    permissionViolationCount,
  };
}
