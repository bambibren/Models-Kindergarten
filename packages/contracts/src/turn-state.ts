import { isRecord } from "./common.js";

export const TURN_STATE_NOTIFICATION = "model-kindergarten/session/turn-state" as const;

export type TurnStatus = "active" | "completed" | "failed" | "cancelled" | "interrupted";
export type TurnActivePhase =
  | "accepted"
  | "preparing_context"
  | "model_streaming"
  | "tool_execution"
  | "finalizing";

export interface TurnWaitingState {
  permission: number;
  input: number;
}

export type ActiveTurnState = {
      schemaVersion: 1;
      turnId: string;
      status: "active";
      phase: TurnActivePhase;
      waitingFor: TurnWaitingState;
    };

export type TerminalTurnState =
  | {
      schemaVersion: 1;
      turnId: string;
      status: "completed";
    }
  | { schemaVersion: 1; turnId: string; status: "failed" }
  | { schemaVersion: 1; turnId: string; status: "cancelled" }
  | { schemaVersion: 1; turnId: string; status: "interrupted" };

export type TurnState = ActiveTurnState | TerminalTurnState;

export interface TurnStateNotification {
  sessionId: string;
  turn: TurnState;
}

export function readTurnStateNotification(value: unknown): TurnStateNotification {
  if (!isRecord(value) || typeof value.sessionId !== "string") {
    throw new Error("Turn 状态通知缺少 sessionId");
  }
  return { sessionId: value.sessionId, turn: readTurnState(value.turn) };
}

export function readTurnState(value: unknown): TurnState {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.turnId !== "string") {
    throw new Error("Turn 状态格式无效");
  }
  if (value.status === "active") {
    if (!isActivePhase(value.phase) || !isWaitingState(value.waitingFor)) {
      throw new Error("活动 Turn 状态格式无效");
    }
    return {
      schemaVersion: 1,
      turnId: value.turnId,
      status: "active",
      phase: value.phase,
      waitingFor: value.waitingFor,
    };
  }
  if (!isTerminalStatus(value.status)) throw new Error("Turn 终态无效");
  return { schemaVersion: 1, turnId: value.turnId, status: value.status };
}

function isActivePhase(value: unknown): value is TurnActivePhase {
  return value === "accepted" || value === "preparing_context" || value === "model_streaming" ||
    value === "tool_execution" || value === "finalizing";
}

function isWaitingState(value: unknown): value is TurnWaitingState {
  return isRecord(value) && nonNegativeInteger(value.permission) && nonNegativeInteger(value.input);
}

function isTerminalStatus(value: unknown): value is Exclude<TurnStatus, "active"> {
  return value === "completed" || value === "failed" || value === "cancelled" || value === "interrupted";
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}
