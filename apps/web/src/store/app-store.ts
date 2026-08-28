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

/** 描述「ConnectionState」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
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
export const useAppStore = create<AppState>(/** 执行「useAppStore」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(set) => ({
  connection: { phase: "connecting" },
  sessions: [],
  chat: emptyChat,
  promptTurn: idlePromptTurn,
  setConnection: /** 更新「setConnection」对应状态，并保持写入顺序、原子性与容量约束。 */
(connection) => set({ connection }),
  setSessions: /** 更新「setSessions」对应状态，并保持写入顺序、原子性与容量约束。 */
(sessions) => set({ sessions }),
  dispatchChat: /** 执行「dispatchChat」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(action) => set(/** 执行「dispatchChat」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(state) => ({ chat: chatReducer(state.chat, action) })),
  dispatchPromptTurn: /** 执行「dispatchPromptTurn」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(action) => set(/** 执行「dispatchPromptTurn」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(state) => ({
    promptTurn: promptTurnReducer(state.promptTurn, action),
  })),
}));
