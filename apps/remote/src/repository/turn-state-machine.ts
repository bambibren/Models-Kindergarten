import {
  waitingForInteractions,
  type ActiveTurnState,
  type TerminalTurnState,
  type TurnActivePhase,
  type TurnPendingInteraction,
  type TurnState,
} from "@kindergarten/contracts";

const transitions: Record<TurnActivePhase, TurnActivePhase[]> = {
  accepted: ["accepted", "preparing_context", "finalizing"],
  preparing_context: ["preparing_context", "model_streaming", "finalizing"],
  model_streaming: ["model_streaming", "tool_execution", "finalizing"],
  tool_execution: ["tool_execution", "model_streaming", "finalizing"],
  finalizing: ["finalizing"],
};

export function initialTurnState(turnId: string): ActiveTurnState {
  return {
    schemaVersion: 1,
    turnId,
    status: "active",
    phase: "accepted",
    waitingFor: { permission: 0, input: 0 },
    pendingInteractions: [],
  };
}

export function transitionActiveTurn(
  current: TurnState,
  phase: TurnActivePhase,
): ActiveTurnState {
  if (current.status !== "active") throw new Error(`Turn 已结束，不能转换活动阶段: ${current.turnId}`);
  if (!transitions[current.phase].includes(phase)) {
    throw new Error(`Turn 阶段转换无效: ${current.phase} -> ${phase}`);
  }
  if (phase !== "tool_execution" && current.pendingInteractions.length > 0) {
    throw new Error(`Turn 仍有 pending interaction，不能进入 ${phase}`);
  }
  return activeState(current, phase, current.pendingInteractions);
}

export function addPendingTurnInteraction(
  current: TurnState,
  interaction: TurnPendingInteraction,
): ActiveTurnState {
  if (current.status !== "active") throw new Error(`Turn 已结束，不能新增 interaction: ${current.turnId}`);
  if (current.phase !== "tool_execution") throw new Error(`只有 tool_execution 可以等待用户: ${current.phase}`);
  if (current.pendingInteractions.some((item) => item.interactionId === interaction.interactionId)) {
    throw new Error(`Turn interaction 已存在: ${interaction.interactionId}`);
  }
  return activeState(current, current.phase, [...current.pendingInteractions, structuredClone(interaction)]);
}

export function removePendingTurnInteraction(
  current: TurnState,
  interactionId: string,
): ActiveTurnState {
  if (current.status !== "active") throw new Error(`Turn 已结束，不能完成 interaction: ${current.turnId}`);
  if (!current.pendingInteractions.some((item) => item.interactionId === interactionId)) {
    throw new Error(`Turn interaction 不存在: ${interactionId}`);
  }
  return activeState(
    current,
    current.phase,
    current.pendingInteractions.filter((item) => item.interactionId !== interactionId),
  );
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

function activeState(
  current: ActiveTurnState,
  phase: TurnActivePhase,
  pendingInteractions: TurnPendingInteraction[],
): ActiveTurnState {
  return {
    schemaVersion: 1,
    turnId: current.turnId,
    status: "active",
    phase,
    waitingFor: waitingForInteractions(pendingInteractions),
    pendingInteractions: structuredClone(pendingInteractions),
  };
}
