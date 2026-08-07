import {
  idlePromptTurn,
  type InteractionCollection,
  type PendingInteractionState,
  type PromptRequestState,
  type PromptTurnFailure,
  type PromptTurnState,
  type TurnAction,
} from "./prompt-turn-types.js";

export type PromptTurnAction =
  | { type: "turn/reset" }
  | { type: "turn/start"; request: PromptRequestState }
  | { type: "interaction/enqueue"; interaction: PendingInteractionState }
  | { type: "interaction/remove"; id: string }
  | {
      type: "turn/complete";
      operationId: string;
      reason: Exclude<import("@agentclientprotocol/sdk").StopReason, "cancelled">;
    }
  | { type: "turn/fail"; operationId: string; failure: PromptTurnFailure }
  | { type: "turn/cancel"; operationId: string };

/**
 * 当前 Prompt Turn 的所有合法转换集中在这里。
 * 组件不再组合 running、error、interaction 等零散字段推断业务状态。
 */
export function promptTurnReducer(
  state: PromptTurnState,
  action: PromptTurnAction,
): PromptTurnState {
  if (action.type === "turn/reset") return idlePromptTurn;
  if (action.type === "turn/start") {
    return { phase: "running", request: action.request };
  }
  if (action.type === "interaction/enqueue") {
    if (state.phase !== "running" && state.phase !== "waiting_for_user") return state;
    const sessionId = interactionSessionId(action.interaction);
    if (sessionId && sessionId !== state.request.sessionId) return state;
    const interactions = state.phase === "waiting_for_user"
      ? addInteraction(state.interactions, action.interaction)
      : addInteraction(emptyInteractions(), action.interaction);
    return { phase: "waiting_for_user", request: state.request, interactions };
  }
  if (action.type === "interaction/remove") {
    if (state.phase !== "waiting_for_user") return state;
    const interactions = removeInteraction(state.interactions, action.id);
    return interactions.order.length > 0
      ? { ...state, interactions }
      : { phase: "running", request: state.request };
  }
  if (!matchesOperation(state, action.operationId)) return state;
  if (action.type === "turn/complete") {
    return { phase: "completed", request: state.request, reason: action.reason };
  }
  if (action.type === "turn/fail") {
    return {
      phase: "failed",
      request: state.request,
      failure: action.failure,
      actions: actionsFor(action.failure),
    };
  }
  return { phase: "cancelled", request: state.request };
}

function interactionSessionId(interaction: PendingInteractionState): string | undefined {
  return "sessionId" in interaction.request && typeof interaction.request.sessionId === "string"
    ? interaction.request.sessionId
    : undefined;
}

function matchesOperation(
  state: PromptTurnState,
  operationId: string,
): state is Extract<PromptTurnState, { request: PromptRequestState }> {
  return (
    (state.phase === "running" || state.phase === "waiting_for_user") &&
    state.request.operationId === operationId
  );
}

function actionsFor(failure: PromptTurnFailure): TurnAction[] {
  return failure.kind === "connection_error"
    ? [{ type: "reconnect", label: "重新连接" }]
    : [{ type: "retry_prompt", label: "重试回答" }];
}

function emptyInteractions(): InteractionCollection {
  return { order: [], byId: {} };
}

function addInteraction(
  state: InteractionCollection,
  interaction: PendingInteractionState,
): InteractionCollection {
  if (state.byId[interaction.id]) return state;
  return {
    order: [...state.order, interaction.id],
    byId: { ...state.byId, [interaction.id]: interaction },
  };
}

function removeInteraction(
  state: InteractionCollection,
  id: string,
): InteractionCollection {
  if (!state.byId[id]) return state;
  const byId = { ...state.byId };
  delete byId[id];
  return { order: state.order.filter((value) => value !== id), byId };
}
