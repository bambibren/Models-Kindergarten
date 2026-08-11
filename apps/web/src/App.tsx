import { useEffect, useRef } from "react";
import type { SessionInfo } from "@agentclientprotocol/sdk";
import type * as acp from "@agentclientprotocol/sdk";
import { AcpWebClient } from "./acp/acp-client.js";
import { ChatViewport } from "./components/chat/ChatViewport.js";
import { Composer } from "./components/composer/Composer.js";
import { ComposerAvailabilityNotice } from "./components/errors/ComposerAvailabilityNotice.js";
import { InteractionPendingPanel } from "./components/interactions/InteractionPendingPanel.js";
import { ChatHeader } from "./components/layout/ChatHeader.js";
import { SessionSidebar } from "./components/layout/SessionSidebar.js";
import {
  isPromptTurnActive,
  type PendingInteractionState,
  type TurnAction,
} from "./prompt-turn/prompt-turn-types.js";
import { useAppStore } from "./store/app-store.js";

const ACP_URL = import.meta.env.VITE_ACP_URL ?? "ws://127.0.0.1:7331/acp";
const REMOTE_CWD = "/workspace";

export default function App() {
  const connection = useAppStore((state) => state.connection);
  const sessions = useAppStore((state) => state.sessions);
  const chat = useAppStore((state) => state.chat);
  const promptTurn = useAppStore((state) => state.promptTurn);
  const clientRef = useRef<AcpWebClient | null>(null);

  useEffect(() => {
    let disposed = false;
    let current: AcpWebClient | null = null;
    const store = useAppStore.getState;

    void (async () => {
      try {
        const client = await AcpWebClient.open(ACP_URL, {
          onUpdate: (value) => store().dispatchChat({ type: "acp/update", value }),
          onContextSummary: (value) => store().dispatchChat({
            type: "context/summary",
            value,
          }),
          onTokenUsage: (value) => store().dispatchChat({
            type: "token/usage",
            value,
          }),
          onInteraction: (interaction) => {
            store().dispatchPromptTurn({ type: "interaction/enqueue", interaction });
          },
          onInteractionResolved: (id) => {
            store().dispatchPromptTurn({ type: "interaction/remove", id });
          },
          onClose: () => {
            if (disposed) return;
            const state = store();
            state.setConnection({
              phase: "disconnected",
              message: "ACP Remote 连接已断开",
            });

            // 断线后不会再收到 Chunk；立即提交已接收内容，并将活动 Turn 收敛为失败。
            const operationId = state.chat.streaming?.operationId;
            if (operationId) {
              state.dispatchChat({ type: "stream/commit", operationId });
            }
            const turn = state.promptTurn;
            if (isPromptTurnActive(turn)) {
              state.dispatchPromptTurn({
                type: "turn/fail",
                operationId: turn.request.operationId,
                failure: {
                  kind: "connection_error",
                  message: "ACP Remote 连接已断开",
                },
              });
            }
          },
        });

        if (disposed) {
          client.close();
          return;
        }
        current = client;
        clientRef.current = client;
        store().setConnection({ phase: "connected" });

        const result = await client.list(REMOTE_CWD);
        store().setSessions(result.sessions);
        const first = result.sessions[0];
        if (first) {
          await loadSession(client, first);
        } else {
          const created = await client.create(REMOTE_CWD);
          openEmptySession(created.sessionId);
          await refreshSessions(client);
        }
      } catch (cause) {
        if (!disposed) {
          store().setConnection({
            phase: "disconnected",
            message: errorMessage(cause),
          });
        }
      }
    })();

    return () => {
      disposed = true;
      current?.close();
      clientRef.current = null;
    };
  }, []);

  function openEmptySession(sessionId: string): void {
    const store = useAppStore.getState();
    store.dispatchPromptTurn({ type: "turn/reset" });
    store.dispatchChat({ type: "session/open", sessionId });
  }

  async function refreshSessions(client = clientRef.current): Promise<void> {
    if (!client) return;
    const result = await client.list(REMOTE_CWD);
    useAppStore.getState().setSessions(result.sessions);
  }

  async function loadSession(client: AcpWebClient, session: SessionInfo): Promise<void> {
    const operationId = crypto.randomUUID();
    const store = useAppStore.getState();
    store.dispatchPromptTurn({ type: "turn/reset" });
    store.dispatchChat({ type: "session/open", sessionId: session.sessionId });
    store.dispatchChat({
      type: "stream/start",
      operationId,
      source: "load",
      turnId: `load:${operationId}`,
    });
    try {
      await client.load(session.sessionId, session.cwd);
    } finally {
      // load 的通知也使用 streamingChatEntries，结束时必须统一提交或清理。
      store.dispatchChat({ type: "stream/commit", operationId });
    }
  }

  async function createSession(): Promise<void> {
    const client = clientRef.current;
    if (!client) return;
    try {
      const created = await client.create(REMOTE_CWD);
      openEmptySession(created.sessionId);
      await refreshSessions(client);
    } catch (cause) {
      // Session 管理失败不属于 Prompt Turn，不能写入 Turn 状态机。
      console.error("创建 Session 失败", cause);
    }
  }

  async function selectSession(session: SessionInfo): Promise<void> {
    const client = clientRef.current;
    if (!client || session.sessionId === useAppStore.getState().chat.sessionId) return;
    try {
      await loadSession(client, session);
    } catch (cause) {
      // V1.6 不引入另一套全局错误中心；保留诊断信息且不污染当前 Turn。
      console.error("加载 Session 失败", cause);
    }
  }

  async function send(text: string): Promise<void> {
    const client = clientRef.current;
    const state = useAppStore.getState();
    const sessionId = state.chat.sessionId;
    if (!client || !sessionId || isPromptTurnActive(state.promptTurn)) return;

    const operationId = crypto.randomUUID();
    const turnId = crypto.randomUUID();
    const request = { operationId, sessionId, turnId, text };
    state.dispatchChat({
      type: "stream/start",
      operationId,
      source: "prompt",
      turnId,
      optimisticContent: [{ type: "text", text }],
    });
    state.dispatchPromptTurn({ type: "turn/start", request });

    try {
      const response = await client.prompt(sessionId, text, { turnId });
      const store = useAppStore.getState();
      store.dispatchChat({ type: "stream/commit", operationId });
      if (response.stopReason === "cancelled") {
        store.dispatchPromptTurn({ type: "turn/cancel", operationId });
      } else {
        store.dispatchPromptTurn({
          type: "turn/complete",
          operationId,
          reason: response.stopReason,
        });
      }
      void refreshSessions(client).catch((cause: unknown) => {
        console.error("刷新 Session 列表失败", cause);
      });
    } catch (cause) {
      const store = useAppStore.getState();
      store.dispatchChat({ type: "stream/commit", operationId });
      store.dispatchPromptTurn({
        type: "turn/fail",
        operationId,
        failure: {
          kind: store.connection.phase === "disconnected"
            ? "connection_error"
            : "backend_error",
          message: errorMessage(cause),
        },
      });
    }
  }

  function cancel(): void {
    const client = clientRef.current;
    const state = useAppStore.getState();
    const turn = state.promptTurn;
    if (!client || !state.chat.sessionId || !isPromptTurnActive(turn)) return;
    const operationId = turn.request.operationId;

    // UI 先进入确定的 cancelled 状态；ACP cancel 随后终止 Remote 的 AbortSignal。
    client.cancelInteractions();
    state.dispatchChat({ type: "stream/commit", operationId });
    state.dispatchPromptTurn({ type: "turn/cancel", operationId });
    void client.cancel(state.chat.sessionId);
  }

  function resolveInteraction(
    interaction: PendingInteractionState,
    value: acp.RequestPermissionResponse | acp.CreateElicitationResponse,
  ): void {
    clientRef.current?.resolveInteraction(interaction, value);
  }

  function handleTurnAction(action: TurnAction): void {
    if (action.type === "reconnect") {
      location.reload();
      return;
    }
    const state = useAppStore.getState().promptTurn;
    if (state.phase === "failed") void send(state.request.text);
  }

  const active = isPromptTurnActive(promptTurn);
  const interactionState = promptTurn.phase === "waiting_for_user"
    ? promptTurn.interactions
    : undefined;
  const activeInteractionId = interactionState?.order[0];
  const activeInteraction = activeInteractionId
    ? interactionState?.byId[activeInteractionId]
    : undefined;
  const ready = connection.phase === "connected" && chat.sessionId !== null;

  return <main className="app-shell">
    <SessionSidebar
      sessions={sessions}
      activeId={chat.sessionId}
      disabled={!ready || active}
      onCreate={() => void createSession()}
      onSelect={(session) => void selectSession(session)}
    />
    <section className="chat-screen">
      <ChatHeader connection={connection} />
      <ChatViewport
        historyChatEntries={chat.historyChatEntries}
        streamingChatEntries={chat.streamingChatEntries}
        promptTurn={promptTurn}
        onTurnAction={handleTurnAction}
      />
      <div className="composer-dock">
        {connection.phase === "disconnected" && <ComposerAvailabilityNotice
          connection={connection}
          onReconnect={() => location.reload()}
        />}
        {activeInteraction && interactionState && <InteractionPendingPanel
          key={activeInteraction.id}
          interaction={activeInteraction}
          queued={interactionState.order.length}
          onResolve={resolveInteraction}
        />}
        <Composer
          disabled={!ready}
          running={active}
          onSend={send}
          onCancel={cancel}
        />
      </div>
    </section>
  </main>;
}

function errorMessage(value: unknown): string {
  if (value instanceof Error && value.message.trim()) return value.message;
  if (typeof value === "string" && value.trim()) return value;
  return "发生未知错误";
}
