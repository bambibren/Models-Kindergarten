import type * as acp from "@agentclientprotocol/sdk";

export interface PromptRequestState {
  operationId: string;
  sessionId: string;
  turnId: string;
  text: string;
}

/**
 * Reverse Request 的协议 continuation 由 ACP Client 持有；这里仅保存 UI 所需数据。
 * 因此 Store 可以保持可预测，React 组件也不会接触 Promise resolver。
 */
export type PendingInteractionState =
  | {
      id: string;
      kind: "permission";
      request: acp.RequestPermissionRequest;
    }
  | {
      id: string;
      kind: "elicitation";
      request: acp.CreateElicitationRequest;
    };

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
  | { phase: "idle" }
  | { phase: "running"; request: PromptRequestState }
  | {
      phase: "waiting_for_user";
      request: PromptRequestState;
      interactions: InteractionCollection;
    }
  | {
      phase: "completed";
      request: PromptRequestState;
      reason: Exclude<acp.StopReason, "cancelled">;
    }
  | {
      phase: "failed";
      request: PromptRequestState;
      failure: PromptTurnFailure;
      actions: TurnAction[];
    }
  | { phase: "cancelled"; request: PromptRequestState };

export const idlePromptTurn: PromptTurnState = { phase: "idle" };

export type ActivePromptTurnState = Extract<
  PromptTurnState,
  { phase: "running" | "waiting_for_user" }
>;

export function isPromptTurnActive(
  state: PromptTurnState,
): state is ActivePromptTurnState {
  return state.phase === "running" || state.phase === "waiting_for_user";
}
