import type * as acp from "@agentclientprotocol/sdk";
import type { ArtifactMentionInput, TurnActivePhase, TurnPendingInteraction, TurnWaitingState } from "@kindergarten/contracts";

/** 描述「PromptRequestState」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface PromptRequestState {
  operationId: string;
  sessionId: string;
  turnId: string;
  text: string;
  artifactMentions?: ArtifactMentionInput[];
}

/** 描述「PendingInteractionState」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type PendingInteractionState =
  | { id: string; kind: "permission"; request: acp.RequestPermissionRequest }
  | { id: string; kind: "elicitation"; request: acp.CreateElicitationRequest };

/** 描述「InteractionCollection」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface InteractionCollection {
  order: string[];
  byId: Record<string, PendingInteractionState>;
}

/** 描述「PromptTurnFailure」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type PromptTurnFailure = {
  kind: "backend_error" | "connection_error";
  message: string;
};

/** 描述「TurnAction」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type TurnAction =
  | { type: "retry_prompt"; label: "重试回答" }
  | { type: "reconnect"; label: "重新连接" };

/** 描述「PromptTurnState」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
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
/** 描述「ActivePromptTurnState」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ActivePromptTurnState = Extract<PromptTurnState, { status: "active" }>;

/** 判断「isPromptTurnActive」对应条件，只返回判定结果且不修改输入状态。 */
export function isPromptTurnActive(state: PromptTurnState): state is ActivePromptTurnState {
  return state.status === "active";
}

/** 判断「canDisplaySessionTokenTotal」对应条件，只返回判定结果且不修改输入状态。 */
export function canDisplaySessionTokenTotal(state: PromptTurnState): boolean {
  return state.status !== "active";
}
