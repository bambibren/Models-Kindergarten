import type { SessionInfo } from "@agentclientprotocol/sdk";
import { create } from "zustand";
import { chatReducer, emptyChat, type ChatAction } from "../chat/chat-reducer.js";
import {
  promptTurnReducer,
  type PromptTurnAction,
} from "../prompt-turn/prompt-turn-reducer.js";
import {
  idlePromptTurn,
  type PromptTurnState,
} from "../prompt-turn/prompt-turn-types.js";

export type ConnectionState =
  | { phase: "connecting" }
  | { phase: "connected" }
  | { phase: "disconnected"; message: string };

interface AppState {
  connection: ConnectionState;
  sessions: SessionInfo[];
  chat: typeof emptyChat;
  promptTurn: PromptTurnState;
  setConnection: (value: ConnectionState) => void;
  setSessions: (value: SessionInfo[]) => void;
  dispatchChat: (action: ChatAction) => void;
  dispatchPromptTurn: (action: PromptTurnAction) => void;
}

/** 一个 Store 聚合应用状态；组件通过窄 selector 各自订阅，不靠 ref 驱动业务 UI。 */
export const useAppStore = create<AppState>((set) => ({
  connection: { phase: "connecting" },
  sessions: [],
  chat: emptyChat,
  promptTurn: idlePromptTurn,
  setConnection: (connection) => set({ connection }),
  setSessions: (sessions) => set({ sessions }),
  dispatchChat: (action) => set((state) => ({ chat: chatReducer(state.chat, action) })),
  dispatchPromptTurn: (action) => set((state) => ({
    promptTurn: promptTurnReducer(state.promptTurn, action),
  })),
}));
