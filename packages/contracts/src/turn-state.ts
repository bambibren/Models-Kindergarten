import { isRecord } from "./common.js";

export const TURN_STATE_NOTIFICATION = "model-kindergarten/session/turn-state" as const;

/** 描述「TurnStatus」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type TurnStatus = "active" | "completed" | "failed" | "cancelled" | "interrupted";
/** 描述「TurnActivePhase」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type TurnActivePhase =
  | "accepted"
  | "preparing_context"
  | "model_streaming"
  | "tool_execution"
  | "finalizing";

/** 描述「TurnWaitingState」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface TurnWaitingState {
  permission: number;
  input: number;
}

/** 描述「TurnToolKind」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
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

/** 描述「TurnToolCallLocation」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface TurnToolCallLocation {
  path: string;
  line?: number;
}

/** 描述「TurnPermissionOption」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface TurnPermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

/** 描述「TurnPendingPermissionInteraction」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
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

/** 描述「TurnPendingElicitationInteraction」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
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

/** 描述「TurnPendingInteraction」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type TurnPendingInteraction =
  | TurnPendingPermissionInteraction
  | TurnPendingElicitationInteraction;

/** 描述「ActiveTurnState」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ActiveTurnState = {
      schemaVersion: 1;
      turnId: string;
      status: "active";
      phase: TurnActivePhase;
      waitingFor: TurnWaitingState;
      pendingInteractions: TurnPendingInteraction[];
    };

/** 描述「TerminalTurnState」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type TerminalTurnState =
  | {
      schemaVersion: 1;
      turnId: string;
      status: "completed";
    }
  | { schemaVersion: 1; turnId: string; status: "failed" }
  | { schemaVersion: 1; turnId: string; status: "cancelled" }
  | { schemaVersion: 1; turnId: string; status: "interrupted" };

/** 描述「TurnState」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type TurnState = ActiveTurnState | TerminalTurnState;

/** 描述「TurnStateNotification」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface TurnStateNotification {
  sessionId: string;
  turn: TurnState;
}

/** 读取「readTurnStateNotification」所需数据，并遵守作用域、分页与容量边界。 */
export function readTurnStateNotification(value: unknown): TurnStateNotification {
  if (!isRecord(value) || typeof value.sessionId !== "string") {
    throw new Error("Turn 状态通知缺少 sessionId");
  }
  return { sessionId: value.sessionId, turn: readTurnState(value.turn) };
}

/** 读取「readTurnState」所需数据，并遵守作用域、分页与容量边界。 */
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

/** 判断「isActivePhase」对应条件，只返回判定结果且不修改输入状态。 */
function isActivePhase(value: unknown): value is TurnActivePhase {
  return value === "accepted" || value === "preparing_context" || value === "model_streaming" ||
    value === "tool_execution" || value === "finalizing";
}

/** 判断「isWaitingState」对应条件，只返回判定结果且不修改输入状态。 */
function isWaitingState(value: unknown): value is TurnWaitingState {
  return isRecord(value) && nonNegativeInteger(value.permission) && nonNegativeInteger(value.input);
}

/** 执行「waitingForInteractions」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function waitingForInteractions(interactions: TurnPendingInteraction[]): TurnWaitingState {
  return {
    permission: interactions.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(interaction) => interaction.kind === "permission").length,
    input: interactions.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(interaction) => interaction.kind === "elicitation").length,
  };
}

/** 根据已校验输入构建「makeTurnInteractionId」结果，不额外持有调用方的大对象。 */
export function makeTurnInteractionId(kind: TurnPendingInteraction["kind"], toolCallId: string): string {
  return `${kind}:${toolCallId}`;
}

/** 读取「readPendingInteractions」所需数据，并遵守作用域、分页与容量边界。 */
function readPendingInteractions(value: unknown): TurnPendingInteraction[] {
  if (!Array.isArray(value)) throw new Error("Turn pendingInteractions 必须是数组");
  const interactions = value.map(readPendingInteraction);
  if (new Set(interactions.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(interaction) => interaction.interactionId)).size !== interactions.length) {
    throw new Error("Turn pendingInteractions interactionId 重复");
  }
  return interactions;
}

/** 读取「readPendingInteraction」所需数据，并遵守作用域、分页与容量边界。 */
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
        locations: value.toolCall.locations.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(location) => ({
          path: location.path,
          ...(location.line === undefined ? {} : { line: location.line }),
        })),
      },
      options: value.options.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(option) => ({ optionId: option.optionId, name: option.name, kind: option.kind })),
      requestedAt: value.requestedAt,
    };
  }
  if (value.kind === "elicitation") {
    if (
      typeof value.toolCallId !== "string" || typeof value.message !== "string" ||
      !isRecord(value.requestedSchema) || value.requestedSchema.type !== "object" ||
      !isRecord(value.requestedSchema.properties) ||
      (value.requestedSchema.required !== undefined &&
        (!Array.isArray(value.requestedSchema.required) || !value.requestedSchema.required.every(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => typeof item === "string")))
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

/** 判断「isToolLocation」对应条件，只返回判定结果且不修改输入状态。 */
function isToolLocation(value: unknown): value is TurnToolCallLocation {
  return isRecord(value) && typeof value.path === "string" &&
    (value.line === undefined || nonNegativeInteger(value.line));
}

/** 判断「isPermissionOption」对应条件，只返回判定结果且不修改输入状态。 */
function isPermissionOption(value: unknown): value is TurnPermissionOption {
  return isRecord(value) && typeof value.optionId === "string" && typeof value.name === "string" &&
    (value.kind === "allow_once" || value.kind === "allow_always" || value.kind === "reject_once" || value.kind === "reject_always");
}

/** 判断「isToolKind」对应条件，只返回判定结果且不修改输入状态。 */
function isToolKind(value: unknown): value is TurnToolKind {
  return value === "read" || value === "edit" || value === "delete" || value === "move" ||
    value === "search" || value === "execute" || value === "think" || value === "fetch" ||
    value === "switch_mode" || value === "other";
}

/** 执行「sameWaiting」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function sameWaiting(left: TurnWaitingState, right: TurnWaitingState): boolean {
  return left.permission === right.permission && left.input === right.input;
}

/** 判断「isTerminalStatus」对应条件，只返回判定结果且不修改输入状态。 */
function isTerminalStatus(value: unknown): value is Exclude<TurnStatus, "active"> {
  return value === "completed" || value === "failed" || value === "cancelled" || value === "interrupted";
}

/** 执行「nonNegativeInteger」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}
