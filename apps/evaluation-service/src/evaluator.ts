import type {
  MinimalTurnEvaluationResult,
  LegacyTurnTraceDocumentV1,
  TurnTraceDocument,
} from "@kindergarten/evaluation-contract";

/** 最小评分集只从 Trace 推导客观结果，不引入权重、Judge 或综合总分。 */
export function evaluateTurn(
  trace: TurnTraceDocument | LegacyTurnTraceDocumentV1,
): MinimalTurnEvaluationResult {
  const signatures = new Set<string>();
  let repeated = false;
  for (const call of trace.toolCalls) {
    const signature = "signatureHash" in call ? call.signatureHash : call.signature;
    if (signatures.has(signature)) repeated = true;
    signatures.add(signature);
  }

  const truncated = new Set(
    trace.modelRounds.flatMap(/** 执行「truncated」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(round) => round.context.truncatedSourceIds),
  );
  const firstTokenAt = trace.modelRounds
    .flatMap(/** 根据已校验输入构建「toSorted」结果，不额外持有调用方的大对象。 */
(round) => round.firstTokenAt === undefined ? [] : [round.firstTokenAt])
    .toSorted(/** 执行「firstTokenAt」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(a, b) => a - b)[0];
  const permissions = new Map(
    trace.permissions.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => [item.toolCallId, item]),
  );
  const permissionViolationCount = trace.toolCalls.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(call) => {
    const protectedCall = call.permission === "ask" || call.permission === "always_ask";
    const actuallyExecuted = call.status === "success" || call.status === "error";
    return protectedCall && actuallyExecuted && permissions.get(call.toolCallId)?.decision !== "allowed";
  }).length;

  return {
    normallyCompleted: trace.status === "completed",
    modelRoundCount: trace.modelRounds.length,
    toolCallCount: trace.toolCalls.length,
    toolSuccessCount: trace.toolCalls.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(call) => call.status === "success").length,
    toolFailureCount: trace.toolCalls.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(call) => call.status === "error").length,
    hasRepeatedToolCall: repeated,
    totalContextTokens: trace.modelRounds.reduce(
      /** 把当前元素归并到有限累加状态，避免额外复制完整集合。 */
(total, round) => total + (round.context.inputTokens ?? 0),
      0,
    ),
    truncatedContextItemCount: truncated.size,
    ...(firstTokenAt === undefined
      ? {}
      : { firstTokenLatencyMs: Math.max(0, firstTokenAt - trace.startedAt) }),
    totalDurationMs: Math.max(0, trace.completedAt - trace.startedAt),
    totalOutputTokens: trace.modelRounds.reduce(
      /** 把当前元素归并到有限累加状态，避免额外复制完整集合。 */
(total, round) => total + (round.outputTokens ?? 0),
      0,
    ),
    errorCount:
      trace.errors.length + trace.toolCalls.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(call) => call.status === "error").length,
    permissionViolationCount,
  };
}
