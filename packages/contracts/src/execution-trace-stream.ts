import { isRecord } from "./common.js";

export const EXECUTION_TRACE_NOTIFICATION =
  "model-kindergarten/session/execution-trace" as const;

type ExecutionEventBase = {
  schemaVersion: 1;
  turnId: string;
  sequence: number;
};

/** 实验运行期间投影到 Web 的最小执行事实；最终事实仍以 Evaluation Trace 为准。 */
export type LiveExecutionEventData =
  | {
      type: "model_round_started";
      roundIndex: number;
      startedAt: number;
    }
  | {
      type: "model_attempt_started";
      roundIndex: number;
      attemptId: string;
      attemptIndex: number;
      maxAttempts: number;
      startedAt: number;
    }
  | {
      type: "model_attempt_failed";
      roundIndex: number;
      attemptId: string;
      attemptIndex: number;
      completedAt: number;
      error: { code: string; message: string; retryable: boolean };
      retryDelayMs?: number;
    }
  | {
      type: "model_attempt_completed";
      roundIndex: number;
      attemptId: string;
      attemptIndex: number;
      completedAt: number;
    }
  | {
      type: "tool_call_started";
      roundIndex: number;
      toolCallId: string;
      name: string;
      title: string;
      startedAt: number;
    }
  | {
      type: "tool_call_completed";
      roundIndex: number;
      toolCallId: string;
      completedAt: number;
      status: "success" | "error" | "denied" | "duplicate_blocked";
      error?: { code: string; message: string };
    };

export type LiveExecutionEvent = ExecutionEventBase & LiveExecutionEventData;

export interface LiveExecutionNotification {
  sessionId: string;
  event: LiveExecutionEvent;
}

/** 校验 ACP 扩展通知，避免不完整或乱型的运行事件进入 UI 状态。 */
export function readLiveExecutionNotification(value: unknown): LiveExecutionNotification {
  if (!isRecord(value) || typeof value.sessionId !== "string" || value.sessionId.length === 0) {
    throw new Error("执行轨迹通知缺少 sessionId");
  }
  return { sessionId: value.sessionId, event: readLiveExecutionEvent(value.event) };
}

function readLiveExecutionEvent(value: unknown): LiveExecutionEvent {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.turnId !== "string" ||
    value.turnId.length === 0 ||
    !isIndex(value.sequence)
  ) {
    throw new Error("执行轨迹事件格式无效");
  }
  const base: ExecutionEventBase = {
    schemaVersion: 1,
    turnId: value.turnId,
    sequence: value.sequence,
  };
  if (value.type === "model_round_started") {
    requireIndex(value.roundIndex, "模型轮次");
    requireTime(value.startedAt, "模型轮次开始时间");
    return { ...base, type: value.type, roundIndex: value.roundIndex, startedAt: value.startedAt };
  }
  if (value.type === "model_attempt_started") {
    requireAttempt(value);
    requireTime(value.startedAt, "模型调用开始时间");
    if (!isIndex(value.maxAttempts) || value.maxAttempts < 1) throw new Error("模型调用总次数无效");
    return {
      ...base,
      type: value.type,
      roundIndex: value.roundIndex,
      attemptId: value.attemptId,
      attemptIndex: value.attemptIndex,
      maxAttempts: value.maxAttempts,
      startedAt: value.startedAt,
    };
  }
  if (value.type === "model_attempt_failed") {
    requireAttempt(value);
    requireTime(value.completedAt, "模型调用结束时间");
    if (!isError(value.error)) throw new Error("模型调用错误无效");
    if (value.retryDelayMs !== undefined && !isNonNegativeNumber(value.retryDelayMs)) {
      throw new Error("模型重试等待时间无效");
    }
    return {
      ...base,
      type: value.type,
      roundIndex: value.roundIndex,
      attemptId: value.attemptId,
      attemptIndex: value.attemptIndex,
      completedAt: value.completedAt,
      error: value.error,
      ...(value.retryDelayMs === undefined ? {} : { retryDelayMs: value.retryDelayMs }),
    };
  }
  if (value.type === "model_attempt_completed") {
    requireAttempt(value);
    requireTime(value.completedAt, "模型调用结束时间");
    return {
      ...base,
      type: value.type,
      roundIndex: value.roundIndex,
      attemptId: value.attemptId,
      attemptIndex: value.attemptIndex,
      completedAt: value.completedAt,
    };
  }
  if (value.type === "tool_call_started") {
    requireTool(value);
    requireTime(value.startedAt, "工具开始时间");
    if (typeof value.name !== "string" || typeof value.title !== "string") throw new Error("工具名称无效");
    return {
      ...base,
      type: value.type,
      roundIndex: value.roundIndex,
      toolCallId: value.toolCallId,
      name: value.name,
      title: value.title,
      startedAt: value.startedAt,
    };
  }
  if (value.type === "tool_call_completed") {
    requireTool(value);
    requireTime(value.completedAt, "工具结束时间");
    if (!isToolStatus(value.status)) throw new Error("工具状态无效");
    if (value.error !== undefined && !isToolError(value.error)) throw new Error("工具错误无效");
    return {
      ...base,
      type: value.type,
      roundIndex: value.roundIndex,
      toolCallId: value.toolCallId,
      completedAt: value.completedAt,
      status: value.status,
      ...(value.error === undefined ? {} : { error: value.error }),
    };
  }
  throw new Error("执行轨迹事件类型无效");
}

function requireAttempt(value: Record<string, unknown>): asserts value is Record<string, unknown> & {
  roundIndex: number;
  attemptId: string;
  attemptIndex: number;
} {
  requireIndex(value.roundIndex, "模型轮次");
  requireIndex(value.attemptIndex, "模型调用序号");
  if (typeof value.attemptId !== "string" || value.attemptId.length === 0) throw new Error("模型调用 ID 无效");
}

function requireTool(value: Record<string, unknown>): asserts value is Record<string, unknown> & {
  roundIndex: number;
  toolCallId: string;
} {
  requireIndex(value.roundIndex, "工具轮次");
  if (typeof value.toolCallId !== "string" || value.toolCallId.length === 0) throw new Error("工具调用 ID 无效");
}

function requireIndex(value: unknown, label: string): asserts value is number {
  if (!isIndex(value)) throw new Error(`${label}无效`);
}

function requireTime(value: unknown, label: string): asserts value is number {
  if (!isNonNegativeNumber(value)) throw new Error(`${label}无效`);
}

function isIndex(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isError(value: unknown): value is { code: string; message: string; retryable: boolean } {
  return isRecord(value) && typeof value.code === "string" && typeof value.message === "string" && typeof value.retryable === "boolean";
}

function isToolError(value: unknown): value is { code: string; message: string } {
  return isRecord(value) && typeof value.code === "string" && typeof value.message === "string";
}

function isToolStatus(value: unknown): value is "success" | "error" | "denied" | "duplicate_blocked" {
  return value === "success" || value === "error" || value === "denied" || value === "duplicate_blocked";
}
