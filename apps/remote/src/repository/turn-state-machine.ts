import type { ActiveTurnState, TerminalTurnState, TurnActivePhase, TurnState, TurnWaitingState } from "@kindergarten/contracts";

const transitions: Record<TurnActivePhase, TurnActivePhase[]> = {
  accepted: ["accepted", "preparing_context", "finalizing"],
  preparing_context: ["preparing_context", "model_streaming", "finalizing"],
  model_streaming: ["model_streaming", "tool_execution", "finalizing"],
  tool_execution: ["tool_execution", "model_streaming", "finalizing"],
  finalizing: ["finalizing"],
};

export const emptyTurnWaiting: TurnWaitingState = { permission: 0, input: 0 };

export function initialTurnState(turnId: string): ActiveTurnState {
  return { schemaVersion: 1, turnId, status: "active", phase: "accepted", waitingFor: { ...emptyTurnWaiting } };
}

export function transitionActiveTurn(
  current: TurnState,
  phase: TurnActivePhase,
  waitingFor: TurnWaitingState = emptyTurnWaiting,
): ActiveTurnState {
  if (current.status !== "active") throw new Error(`Turn 已结束，不能转换活动阶段: ${current.turnId}`);
  if (!transitions[current.phase].includes(phase)) {
    throw new Error(`Turn 阶段转换无效: ${current.phase} -> ${phase}`);
  }
  assertWaiting(phase, waitingFor);
  return { schemaVersion: 1, turnId: current.turnId, status: "active", phase, waitingFor: { ...waitingFor } };
}

export function finishTurnState(
  current: TurnState,
  status: TerminalTurnState["status"],
): TerminalTurnState {
  if (current.status !== "active") throw new Error(`Turn 已结束，不能再次写入终态: ${current.turnId}`);
  if (current.phase !== "finalizing") throw new Error(`Turn 必须先进入 finalizing 才能结束: ${current.turnId}`);
  return { schemaVersion: 1, turnId: current.turnId, status };
}

export function interruptTurnState(current: TurnState): Extract<TerminalTurnState, { status: "interrupted" }> {
  if (current.status !== "active") throw new Error(`只有活动 Turn 可以恢复为 interrupted: ${current.turnId}`);
  return { schemaVersion: 1, turnId: current.turnId, status: "interrupted" };
}

function assertWaiting(phase: TurnActivePhase, waiting: TurnWaitingState): void {
  if (!Number.isInteger(waiting.permission) || waiting.permission < 0 || !Number.isInteger(waiting.input) || waiting.input < 0) {
    throw new Error("Turn waitingFor 必须是非负整数");
  }
  if (phase !== "tool_execution" && (waiting.permission !== 0 || waiting.input !== 0)) {
    throw new Error(`只有 tool_execution 可以等待用户: ${phase}`);
  }
}
