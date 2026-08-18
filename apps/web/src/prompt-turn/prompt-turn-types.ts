import type * as acp from "@agentclientprotocol/sdk";
import type { ArtifactMentionInput, TurnActivePhase, TurnPendingInteraction, TurnWaitingState } from "@kindergarten/contracts";

export interface PromptRequestState {
  operationId: string;
  sessionId: string;
  turnId: string;
  text: string;
  artifactMentions?: ArtifactMentionInput[];
}

export type PendingInteractionState =
  | { id: string; kind: "permission"; request: acp.RequestPermissionRequest }
  | { id: string; kind: "elicitation"; request: acp.CreateElicitationRequest };

export interface InteractionCollection {
  order: string[];
  byId: Record<string, PendingInteractionState>;
}

export type PromptTurnFailure = {
  kind: "backend_error" | "connection_error";
  message: string;
};

export type TurnAction =
  | { type: "retry_prompt"; label: "重试回答" }
  | { type: "reconnect"; label: "重新连接" };

export type PromptTurnState =
  | { status: "idle" }
  | {
      status: "active";
      phase: TurnActivePhase;
      waitingFor: TurnWaitingState;
      pendingInteractions: TurnPendingInteraction[];
      request: PromptRequestState;
      interactions: InteractionCollection;
    }
  | { status: "completed"; request: PromptRequestState; reason: Exclude<acp.StopReason, "cancelled"> }
  | { status: "failed"; request: PromptRequestState; failure: PromptTurnFailure; actions: TurnAction[] }
  | { status: "cancelled"; request: PromptRequestState }
  | { status: "interrupted"; request: PromptRequestState; actions: TurnAction[] };

export const idlePromptTurn: PromptTurnState = { status: "idle" };
export type ActivePromptTurnState = Extract<PromptTurnState, { status: "active" }>;

export function isPromptTurnActive(state: PromptTurnState): state is ActivePromptTurnState {
  return state.status === "active";
}

export function canDisplaySessionTokenTotal(state: PromptTurnState): boolean {
  return state.status !== "active";
}
