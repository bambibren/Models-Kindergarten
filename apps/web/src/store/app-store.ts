import type { SessionInfo } from "@agentclientprotocol/sdk";
import type * as acp from "@agentclientprotocol/sdk";
import { create } from "zustand";
import { chatReducer, emptyChat, type ChatAction } from "../chat/chat-reducer.js";

export type ConnectionState = "connecting" | "connected" | "disconnected";
export type PendingInteraction =
  | { id: string; kind: "permission"; request: acp.RequestPermissionRequest; resolve: (value: acp.RequestPermissionResponse) => void }
  | { id: string; kind: "elicitation"; request: acp.CreateElicitationRequest; resolve: (value: acp.CreateElicitationResponse) => void };

interface AppState {
  connection: ConnectionState;
  sessions: SessionInfo[];
  chat: typeof emptyChat;
  running: boolean;
  error: string;
  interactionOrder: string[];
  interactionsById: Record<string, PendingInteraction>;
  setConnection: (value: ConnectionState) => void;
  setSessions: (value: SessionInfo[]) => void;
  dispatchChat: (action: ChatAction) => void;
  setRunning: (value: boolean) => void;
  setError: (value: string) => void;
  enqueueInteraction: (value: PendingInteraction) => void;
  removeInteraction: (id: string) => void;
  clearInteractions: () => void;
}

/** 一个 Store 聚合应用状态；组件通过窄 selector 各自订阅，不靠 ref 驱动业务 UI。 */
export const useAppStore = create<AppState>((set) => ({
  connection: "connecting",
  sessions: [],
  chat: emptyChat,
  running: false,
  error: "",
  interactionOrder: [],
  interactionsById: {},
  setConnection: (connection) => set({ connection }),
  setSessions: (sessions) => set({ sessions }),
  dispatchChat: (action) => set((state) => ({ chat: chatReducer(state.chat, action) })),
  setRunning: (running) => set({ running }),
  setError: (error) => set({ error }),
  enqueueInteraction: (interaction) => set((state) => ({
    interactionOrder: [...state.interactionOrder, interaction.id],
    interactionsById: { ...state.interactionsById, [interaction.id]: interaction },
  })),
  removeInteraction: (id) => set((state) => {
    const interactionsById = { ...state.interactionsById };
    delete interactionsById[id];
    return { interactionOrder: state.interactionOrder.filter((value) => value !== id), interactionsById };
  }),
  clearInteractions: () => set({ interactionOrder: [], interactionsById: {} }),
}));
