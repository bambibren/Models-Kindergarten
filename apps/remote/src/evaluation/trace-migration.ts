import { createHash } from "node:crypto";
import {
  isLegacyTurnTraceDocumentV1,
  isTurnTraceDocument,
  type LegacyTurnTraceDocumentV1,
  type TurnTraceDocument,
} from "@kindergarten/evaluation-contract";

interface RuntimePayloadEvidence {
  sha256: string;
  bytes: number;
}

/** 把 API 或旧单文件中的 Trace 统一转换为不含原始正文的 V2。 */
export function normalizeTurnTrace(value: unknown): TurnTraceDocument {
  if (isTurnTraceDocument(value)) return structuredClone(value);
  if (!isLegacyTurnTraceDocumentV1(value)) throw new Error("Turn Trace 文档格式无效");
  return migrateV1(value);
}

/** V1 到 V2 只删除大正文并生成摘要，评分所需计数、状态和时间戳保持不变。 */
function migrateV1(trace: LegacyTurnTraceDocumentV1): TurnTraceDocument {
  return {
    schemaVersion: 2,
    traceId: trace.traceId,
    runId: trace.runId,
    sessionId: trace.sessionId,
    turnId: trace.turnId,
    variant: structuredClone(trace.variant),
    resolvedReasoning: structuredClone(trace.resolvedReasoning),
    status: trace.status,
    ...(trace.stopReason ? { stopReason: trace.stopReason } : {}),
    startedAt: trace.startedAt,
    completedAt: trace.completedAt,
    modelRounds: trace.modelRounds.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(round) => ({
      id: round.id,
      index: round.index,
      startedAt: round.startedAt,
      resolvedReasoning: structuredClone(round.resolvedReasoning),
      ...(round.firstTokenAt === undefined ? {} : { firstTokenAt: round.firstTokenAt }),
      ...(round.completedAt === undefined ? {} : { completedAt: round.completedAt }),
      ...(round.stopReason === undefined ? {} : { stopReason: round.stopReason }),
      ...(round.output ? {
        output: {
          text: evidence(round.output.text),
          ...(round.output.thinking === undefined
            ? {}
            : { thinking: evidence(round.output.thinking) }),
        },
      } : {}),
      context: {
        messages: round.context.messages.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(message) => ({
          role: message.role,
          source: message.source,
          ...(message.sourceId ? { sourceId: message.sourceId } : {}),
          contentHash: evidence(message.content).sha256,
          byteLength: evidence(message.content).bytes,
          estimatedTokens: message.estimatedTokens,
        })),
        truncatedSourceIds: [...round.context.truncatedSourceIds],
        ...(round.context.inputTokens === undefined
          ? {}
          : { inputTokens: round.context.inputTokens }),
      },
      ...(round.outputTokens === undefined ? {} : { outputTokens: round.outputTokens }),
      ...(round.cachedInputTokens === undefined
        ? {}
        : { cachedInputTokens: round.cachedInputTokens }),
      ...(round.reasoningOutputTokens === undefined
        ? {}
        : { reasoningOutputTokens: round.reasoningOutputTokens }),
    })),
    toolCalls: trace.toolCalls.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(call) => ({
      toolCallId: call.toolCallId,
      modelRoundId: call.modelRoundId,
      name: call.name,
      arguments: evidence(call.arguments),
      signatureHash: evidence(call.signature).sha256,
      permission: call.permission,
      ...(call.status === undefined ? {} : { status: call.status }),
      startedAt: call.startedAt,
      ...(call.completedAt === undefined ? {} : { completedAt: call.completedAt }),
      ...(call.error === undefined ? {} : { error: structuredClone(call.error) }),
      ...(call.output === undefined ? {} : { output: evidence(call.output) }),
    })),
    permissions: structuredClone(trace.permissions),
    errors: structuredClone(trace.errors),
  };
}

/** 对字符串直接哈希，对结构化值使用 JSON 表示；V1 数据本来就要求可持久化。 */
function evidence(value: unknown): RuntimePayloadEvidence {
  const serialized = typeof value === "string" ? value : JSON.stringify(value) ?? "null";
  return {
    sha256: createHash("sha256").update(serialized).digest("hex"),
    bytes: Buffer.byteLength(serialized),
  };
}
