import type {
  ContextMessageObservation,
  RuntimeVariantSnapshot,
} from "@kindergarten/runtime-observation";

export interface ModelRoundTrace {
  id: string;
  index: number;
  startedAt: number;
  firstTokenAt?: number;
  completedAt?: number;
  stopReason?: "stop" | "length" | "cancelled";
  output?: {
    text: string;
    thinking?: string;
  };
  context: {
    messages: ContextMessageObservation[];
    truncatedSourceIds: string[];
    inputTokens?: number;
  };
  outputTokens?: number;
}

export interface ToolCallTrace {
  toolCallId: string;
  modelRoundId: string;
  name: string;
  arguments: unknown;
  signature: string;
  permission: "allow" | "ask" | "always_ask" | "deny";
  status?: "success" | "error" | "denied" | "duplicate_blocked";
  startedAt: number;
  completedAt?: number;
  error?: { category: string; message: string };
  output?: unknown;
}

export interface PermissionTrace {
  toolCallId: string;
  required: boolean;
  decision: "allowed" | "denied";
  decidedAt: number;
}

export interface RuntimeErrorTrace {
  scope: "model" | "tool_runtime" | "turn";
  message: string;
  at: number;
}

export interface TurnTraceDocument {
  schemaVersion: 1;
  traceId: string;
  runId: string;
  sessionId: string;
  turnId: string;
  variant: RuntimeVariantSnapshot;
  status: "completed" | "failed" | "cancelled";
  stopReason?: string;
  startedAt: number;
  completedAt: number;
  modelRounds: ModelRoundTrace[];
  toolCalls: ToolCallTrace[];
  permissions: PermissionTrace[];
  errors: RuntimeErrorTrace[];
}

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

export interface TurnEvaluationRecord {
  schemaVersion: 1;
  trace: TurnTraceDocument;
  result: MinimalTurnEvaluationResult;
  createdAt: string;
}

/** HTTP 边界只接受完整的终态 Trace；更细的字段由受信任 Exporter 生成。 */
export function isTurnTraceDocument(value: unknown): value is TurnTraceDocument {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
