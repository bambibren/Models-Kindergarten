import type {
  ModelInputMessageTrace,
  RuntimePayloadEvidence,
  RuntimeResolvedReasoningSnapshot,
  RuntimeVariantSnapshot,
} from "@kindergarten/runtime-observation";

/** 描述「ModelRoundTrace」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ModelRoundTrace {
  id: string;
  index: number;
  startedAt: number;
  resolvedReasoning: RuntimeResolvedReasoningSnapshot;
  firstTokenAt?: number;
  completedAt?: number;
  stopReason?: "stop" | "length" | "cancelled";
  output?: {
    text: RuntimePayloadEvidence;
    thinking?: RuntimePayloadEvidence;
  };
  context: {
    messages: ModelInputMessageTrace[];
    truncatedSourceIds: string[];
    inputTokens?: number;
  };
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
}

/** 描述「ToolCallTrace」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ToolCallTrace {
  toolCallId: string;
  modelRoundId: string;
  name: string;
  arguments: RuntimePayloadEvidence;
  signatureHash: string;
  permission: "allow" | "ask" | "always_ask" | "deny";
  status?: "success" | "error" | "denied" | "duplicate_blocked";
  startedAt: number;
  completedAt?: number;
  error?: { category: string; message: string };
  output?: RuntimePayloadEvidence;
}

/** 描述「PermissionTrace」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface PermissionTrace {
  toolCallId: string;
  required: boolean;
  decision: "allowed" | "denied";
  decidedAt: number;
}

/** 描述「RuntimeErrorTrace」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface RuntimeErrorTrace {
  scope: "model" | "tool_runtime" | "turn";
  message: string;
  at: number;
}

/** 描述「TurnTraceDocument」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface TurnTraceDocument {
  schemaVersion: 2;
  traceId: string;
  runId: string;
  sessionId: string;
  turnId: string;
  variant: RuntimeVariantSnapshot;
  resolvedReasoning: RuntimeResolvedReasoningSnapshot;
  status: "completed" | "failed" | "cancelled";
  stopReason?: string;
  startedAt: number;
  completedAt: number;
  modelRounds: ModelRoundTrace[];
  toolCalls: ToolCallTrace[];
  permissions: PermissionTrace[];
  errors: RuntimeErrorTrace[];
}

/** 描述「MinimalTurnEvaluationResult」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface MinimalTurnEvaluationResult {
  normallyCompleted: boolean;
  modelRoundCount: number;
  toolCallCount: number;
  toolSuccessCount: number;
  toolFailureCount: number;
  hasRepeatedToolCall: boolean;
  totalContextTokens: number;
  truncatedContextItemCount: number;
  firstTokenLatencyMs?: number;
  totalDurationMs: number;
  totalOutputTokens: number;
  errorCount: number;
  permissionViolationCount: number;
}

/** 描述「TurnEvaluationRecord」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface TurnEvaluationRecord {
  schemaVersion: 2;
  trace: TurnTraceDocument;
  result: MinimalTurnEvaluationResult;
  createdAt: string;
}

/** Evaluation 模块只接受 Runtime 生成的完整终态 Trace。 */
export function isTurnTraceDocument(value: unknown): value is TurnTraceDocument {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === 2 &&
    typeof value.traceId === "string" &&
    typeof value.runId === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.turnId === "string" &&
    (value.status === "completed" || value.status === "failed" || value.status === "cancelled") &&
    typeof value.startedAt === "number" &&
    typeof value.completedAt === "number" &&
    Array.isArray(value.modelRounds) &&
    Array.isArray(value.toolCalls) &&
    Array.isArray(value.permissions) &&
    Array.isArray(value.errors) &&
    isRecord(value.variant)
  );
}

/** Trace V1 只用于旧 Evaluation 单文件迁移和等价评分测试，不再由 Runtime 生成。 */
export interface LegacyTurnTraceDocumentV1 {
  schemaVersion: 1;
  traceId: string;
  runId: string;
  sessionId: string;
  turnId: string;
  variant: RuntimeVariantSnapshot;
  resolvedReasoning: RuntimeResolvedReasoningSnapshot;
  status: "completed" | "failed" | "cancelled";
  stopReason?: string;
  startedAt: number;
  completedAt: number;
  modelRounds: Array<Omit<ModelRoundTrace, "context" | "output"> & {
    context: {
      messages: Array<{
        role: "system" | "user" | "assistant" | "tool";
        source: ModelInputMessageTrace["source"];
        sourceId?: string;
        content: string;
        estimatedTokens: number;
      }>;
      truncatedSourceIds: string[];
      inputTokens?: number;
    };
    output?: { text: string; thinking?: string };
  }>;
  toolCalls: Array<Omit<ToolCallTrace, "arguments" | "signatureHash" | "output"> & {
    arguments: unknown;
    signature: string;
    output?: unknown;
  }>;
  permissions: PermissionTrace[];
  errors: RuntimeErrorTrace[];
}

/** V1 数据迁移入口只做外层形状识别，字段摘要由 Evaluation 模块生成。 */
export function isLegacyTurnTraceDocumentV1(value: unknown): value is LegacyTurnTraceDocumentV1 {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === 1 &&
    typeof value.traceId === "string" &&
    typeof value.runId === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.turnId === "string" &&
    (value.status === "completed" || value.status === "failed" || value.status === "cancelled") &&
    typeof value.startedAt === "number" &&
    typeof value.completedAt === "number" &&
    Array.isArray(value.modelRounds) &&
    Array.isArray(value.toolCalls) &&
    Array.isArray(value.permissions) &&
    Array.isArray(value.errors) &&
    isRecord(value.variant)
  );
}

/** 判断「isRecord」对应条件，只返回判定结果且不修改输入状态。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
