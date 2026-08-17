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

export type TurnToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

export interface TurnToolCallLocation {
  path: string;
  line?: number;
}

export interface TurnPermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export interface TurnPendingPermissionInteraction {
  schemaVersion: 1;
  interactionId: string;
  kind: "permission";
  toolCall: {
    toolCallId: string;
    title: string;
    name: string;
    kind: TurnToolKind;
    rawInput: unknown;
    locations: TurnToolCallLocation[];
  };
  options: TurnPermissionOption[];
  requestedAt: string;
}

export interface TurnPendingElicitationInteraction {
  schemaVersion: 1;
  interactionId: string;
  kind: "elicitation";
  toolCallId: string;
  message: string;
  requestedSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  requestedAt: string;
}

export type TurnPendingInteraction =
  | TurnPendingPermissionInteraction
  | TurnPendingElicitationInteraction;

export type ActiveTurnState = {
      schemaVersion: 1;
      turnId: string;
      status: "active";
      phase: TurnActivePhase;
      waitingFor: TurnWaitingState;
      pendingInteractions: TurnPendingInteraction[];
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
    const pendingInteractions = value.pendingInteractions === undefined
      ? []
      : readPendingInteractions(value.pendingInteractions);
    const waitingFor = waitingForInteractions(pendingInteractions);
    if (value.pendingInteractions !== undefined && !sameWaiting(value.waitingFor, waitingFor)) {
      throw new Error("Turn waitingFor 与 pendingInteractions 不一致");
    }
    if (value.phase !== "tool_execution" && pendingInteractions.length > 0) {
      throw new Error(`只有 tool_execution 可以等待用户: ${value.phase}`);
    }
    return {
      schemaVersion: 1,
      turnId: value.turnId,
      status: "active",
      phase: value.phase,
      waitingFor,
      pendingInteractions,
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

export function waitingForInteractions(interactions: TurnPendingInteraction[]): TurnWaitingState {
  return {
    permission: interactions.filter((interaction) => interaction.kind === "permission").length,
    input: interactions.filter((interaction) => interaction.kind === "elicitation").length,
  };
}

export function makeTurnInteractionId(kind: TurnPendingInteraction["kind"], toolCallId: string): string {
  return `${kind}:${toolCallId}`;
}

function readPendingInteractions(value: unknown): TurnPendingInteraction[] {
  if (!Array.isArray(value)) throw new Error("Turn pendingInteractions 必须是数组");
  const interactions = value.map(readPendingInteraction);
  if (new Set(interactions.map((interaction) => interaction.interactionId)).size !== interactions.length) {
    throw new Error("Turn pendingInteractions interactionId 重复");
  }
  return interactions;
}

function readPendingInteraction(value: unknown): TurnPendingInteraction {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.interactionId !== "string" || typeof value.requestedAt !== "string") {
    throw new Error("Turn pending interaction 格式无效");
  }
  if (value.kind === "permission") {
    if (!isRecord(value.toolCall) || !isToolKind(value.toolCall.kind) || !Array.isArray(value.toolCall.locations)) {
      throw new Error("Turn pending permission toolCall 格式无效");
    }
    if (
      typeof value.toolCall.toolCallId !== "string" || typeof value.toolCall.title !== "string" ||
      typeof value.toolCall.name !== "string" || !value.toolCall.locations.every(isToolLocation) ||
      !Array.isArray(value.options) || !value.options.every(isPermissionOption)
    ) throw new Error("Turn pending permission 格式无效");
    return {
      schemaVersion: 1,
      interactionId: value.interactionId,
      kind: "permission",
      toolCall: {
        toolCallId: value.toolCall.toolCallId,
        title: value.toolCall.title,
        name: value.toolCall.name,
        kind: value.toolCall.kind,
        rawInput: value.toolCall.rawInput,
        locations: value.toolCall.locations.map((location) => ({
          path: location.path,
          ...(location.line === undefined ? {} : { line: location.line }),
        })),
      },
      options: value.options.map((option) => ({ optionId: option.optionId, name: option.name, kind: option.kind })),
      requestedAt: value.requestedAt,
    };
  }
  if (value.kind === "elicitation") {
    if (
      typeof value.toolCallId !== "string" || typeof value.message !== "string" ||
      !isRecord(value.requestedSchema) || value.requestedSchema.type !== "object" ||
      !isRecord(value.requestedSchema.properties) ||
      (value.requestedSchema.required !== undefined &&
        (!Array.isArray(value.requestedSchema.required) || !value.requestedSchema.required.every((item) => typeof item === "string")))
    ) throw new Error("Turn pending elicitation 格式无效");
    return {
      schemaVersion: 1,
      interactionId: value.interactionId,
      kind: "elicitation",
      toolCallId: value.toolCallId,
      message: value.message,
      requestedSchema: {
        type: "object",
        properties: value.requestedSchema.properties,
        ...(value.requestedSchema.required === undefined ? {} : { required: value.requestedSchema.required as string[] }),
      },
      requestedAt: value.requestedAt,
    };
  }
  throw new Error("Turn pending interaction kind 无效");
}

function isToolLocation(value: unknown): value is TurnToolCallLocation {
  return isRecord(value) && typeof value.path === "string" &&
    (value.line === undefined || nonNegativeInteger(value.line));
}

function isPermissionOption(value: unknown): value is TurnPermissionOption {
  return isRecord(value) && typeof value.optionId === "string" && typeof value.name === "string" &&
    (value.kind === "allow_once" || value.kind === "allow_always" || value.kind === "reject_once" || value.kind === "reject_always");
}

function isToolKind(value: unknown): value is TurnToolKind {
  return value === "read" || value === "edit" || value === "delete" || value === "move" ||
    value === "search" || value === "execute" || value === "think" || value === "fetch" ||
    value === "switch_mode" || value === "other";
}

function sameWaiting(left: TurnWaitingState, right: TurnWaitingState): boolean {
  return left.permission === right.permission && left.input === right.input;
}

function isTerminalStatus(value: unknown): value is Exclude<TurnStatus, "active"> {
  return value === "completed" || value === "failed" || value === "cancelled" || value === "interrupted";
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}
