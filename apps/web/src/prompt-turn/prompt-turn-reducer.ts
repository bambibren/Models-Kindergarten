import type { TurnState } from "@kindergarten/contracts";
import type { ArtifactMentionInput } from "@kindergarten/contracts";
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
  | { type: "turn/remote-state"; sessionId: string; turn: TurnState; restoredText?: string; restoredArtifactMentions?: ArtifactMentionInput[] }
  | { type: "interaction/enqueue"; interaction: PendingInteractionState }
  | { type: "interaction/remove"; id: string }
  | { type: "turn/complete"; operationId: string; reason: Exclude<import("@agentclientprotocol/sdk").StopReason, "cancelled"> }
  | { type: "turn/fail"; operationId: string; failure: PromptTurnFailure }
  | { type: "turn/cancel"; operationId: string };

export function promptTurnReducer(state: PromptTurnState, action: PromptTurnAction): PromptTurnState {
  if (action.type === "turn/reset") return idlePromptTurn;
  if (action.type === "turn/start") {
    return {
      status: "active",
      phase: "accepted",
      waitingFor: { permission: 0, input: 0 },
      pendingInteractions: [],
      request: action.request,
      interactions: emptyInteractions(),
    };
  }
  if (action.type === "turn/remote-state") return reduceRemoteState(state, action.sessionId, action.turn, action.restoredText, action.restoredArtifactMentions);
  if (action.type === "interaction/enqueue") {
    if (state.status !== "active") return state;
    const sessionId = interactionSessionId(action.interaction);
    if (sessionId && sessionId !== state.request.sessionId) return state;
    if (!state.pendingInteractions.some((interaction) => interaction.interactionId === action.interaction.id)) return state;
    return { ...state, interactions: addInteraction(state.interactions, action.interaction) };
  }
  if (action.type === "interaction/remove") {
    return state.status === "active" ? { ...state, interactions: removeInteraction(state.interactions, action.id) } : state;
  }
  if (!matchesOperation(state, action.operationId)) return state;
  if (action.type === "turn/complete") {
    if (state.status === "completed") return state;
    if (state.status !== "active") return state;
    return { status: "completed", request: state.request, reason: action.reason };
  }
  if (action.type === "turn/fail") {
    if (state.status !== "active" && state.status !== "failed") return state;
    return { status: "failed", request: state.request, failure: action.failure, actions: actionsFor(action.failure) };
  }
  if (state.status !== "active") return state;
  return { status: "cancelled", request: state.request };
}

function reduceRemoteState(state: PromptTurnState, sessionId: string, turn: TurnState, restoredText = "", restoredArtifactMentions: ArtifactMentionInput[] = []): PromptTurnState {
  if (state.status === "idle") {
    if (turn.status !== "active") return state;
    return {
      status: "active",
      phase: turn.phase,
      waitingFor: turn.waitingFor,
      pendingInteractions: turn.pendingInteractions,
      request: {
        operationId: `remote:${sessionId}:${turn.turnId}`,
        sessionId,
        turnId: turn.turnId,
        text: restoredText,
        ...(restoredArtifactMentions.length ? { artifactMentions: restoredArtifactMentions } : {}),
      },
      interactions: emptyInteractions(),
    };
  }
  if (state.request.sessionId !== sessionId || state.request.turnId !== turn.turnId) return state;
  if (turn.status === "active") {
    if (state.status !== "active") return state;
    const ids = new Set(turn.pendingInteractions.map((interaction) => interaction.interactionId));
    return {
      ...state,
      phase: turn.phase,
      waitingFor: turn.waitingFor,
      pendingInteractions: turn.pendingInteractions,
      interactions: retainInteractions(state.interactions, ids),
    };
  }
  if (turn.status === "completed") return { status: "completed", request: state.request, reason: "end_turn" };
  if (turn.status === "cancelled") return { status: "cancelled", request: state.request };
  if (turn.status === "interrupted") return { status: "interrupted", request: state.request, actions: [{ type: "retry_prompt", label: "重试回答" }] };
  return {
    status: "failed",
    request: state.request,
    failure: { kind: "backend_error", message: "该轮执行失败" },
    actions: [{ type: "retry_prompt", label: "重试回答" }],
  };
}

function interactionSessionId(interaction: PendingInteractionState): string | undefined {
  return "sessionId" in interaction.request && typeof interaction.request.sessionId === "string" ? interaction.request.sessionId : undefined;
}

function matchesOperation(state: PromptTurnState, operationId: string): state is Exclude<PromptTurnState, { status: "idle" }> {
  return state.status !== "idle" && state.request.operationId === operationId;
}

function actionsFor(failure: PromptTurnFailure): TurnAction[] {
  return failure.kind === "connection_error" ? [{ type: "reconnect", label: "重新连接" }] : [{ type: "retry_prompt", label: "重试回答" }];
}

function emptyInteractions(): InteractionCollection { return { order: [], byId: {} }; }
function addInteraction(state: InteractionCollection, interaction: PendingInteractionState): InteractionCollection {
  if (state.byId[interaction.id]) return state;
  return { order: [...state.order, interaction.id], byId: { ...state.byId, [interaction.id]: interaction } };
}
function removeInteraction(state: InteractionCollection, id: string): InteractionCollection {
  if (!state.byId[id]) return state;
  const byId = { ...state.byId }; delete byId[id];
  return { order: state.order.filter((value) => value !== id), byId };
}
function retainInteractions(state: InteractionCollection, ids: Set<string>): InteractionCollection {
  const order = state.order.filter((id) => ids.has(id));
  return { order, byId: Object.fromEntries(order.map((id) => [id, state.byId[id]!])) };
}
