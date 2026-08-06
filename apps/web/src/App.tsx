import { useEffect, useRef } from "react";
import type { SessionInfo } from "@agentclientprotocol/sdk";
import type * as acp from "@agentclientprotocol/sdk";
import { AcpWebClient } from "./acp/acp-client.js";
import { ChatViewport } from "./components/chat/ChatViewport.js";
import { Composer } from "./components/composer/Composer.js";
import { InteractionPendingPanel } from "./components/interactions/InteractionPendingPanel.js";
import { ChatHeader } from "./components/layout/ChatHeader.js";
import { SessionSidebar } from "./components/layout/SessionSidebar.js";
import { useAppStore, type PendingInteraction } from "./store/app-store.js";

const ACP_URL = import.meta.env.VITE_ACP_URL ?? "ws://127.0.0.1:7331/acp";
const REMOTE_CWD = "/workspace";

export default function App() {
  const connection = useAppStore((state) => state.connection);
  const sessions = useAppStore((state) => state.sessions);
  const chat = useAppStore((state) => state.chat);
  const running = useAppStore((state) => state.running);
  const error = useAppStore((state) => state.error);
  const interactionOrder = useAppStore((state) => state.interactionOrder);
  const interactionsById = useAppStore((state) => state.interactionsById);
  const clientRef = useRef<AcpWebClient | null>(null);

  useEffect(() => {
    let disposed = false;
    let current: AcpWebClient | null = null;
    const store = useAppStore.getState;
    void (async () => {
      try {
        const client = await AcpWebClient.open(ACP_URL, {
          onUpdate: (value) => store().dispatchChat({ type: "acp/update", value }),
          onPermission: (request) => enqueuePermission(request),
          onElicitation: (request) => enqueueElicitation(request),
          onClose: () => { if (!disposed) { cancelInteractions(); store().setConnection("disconnected"); } },
        });
        if (disposed) { client.close(); return; }
        current = client;
        clientRef.current = client;
        store().setConnection("connected");
        const result = await client.list(REMOTE_CWD);
        store().setSessions(result.sessions);
        const first = result.sessions[0];
        if (first) await loadSession(client, first);
        else { const created = await client.create(REMOTE_CWD); store().dispatchChat({ type: "session/open", sessionId: created.sessionId }); await refreshSessions(client); }
      } catch (cause) {
        if (!disposed) { store().setConnection("disconnected"); store().setError(errorText(cause)); }
      }
    })();
    return () => { disposed = true; current?.close(); clientRef.current = null; };
  }, []);

  function enqueuePermission(request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    return new Promise((resolve) => useAppStore.getState().enqueueInteraction({ id: crypto.randomUUID(), kind: "permission", request, resolve }));
  }
  function enqueueElicitation(request: acp.CreateElicitationRequest): Promise<acp.CreateElicitationResponse> {
    return new Promise((resolve) => useAppStore.getState().enqueueInteraction({ id: crypto.randomUUID(), kind: "elicitation", request, resolve }));
  }
  function resolveInteraction(interaction: PendingInteraction, value: acp.RequestPermissionResponse | acp.CreateElicitationResponse) {
    if (interaction.kind === "permission") interaction.resolve(value as acp.RequestPermissionResponse);
    else interaction.resolve(value as acp.CreateElicitationResponse);
    useAppStore.getState().removeInteraction(interaction.id);
  }
  function cancelInteractions() {
    const state = useAppStore.getState();
    for (const id of state.interactionOrder) {
      const interaction = state.interactionsById[id];
      if (!interaction) continue;
      if (interaction.kind === "permission") interaction.resolve({ outcome: { outcome: "cancelled" } });
      else interaction.resolve({ action: "cancel" });
    }
    state.clearInteractions();
  }
  async function refreshSessions(client = clientRef.current) { if (!client) return; useAppStore.getState().setSessions((await client.list(REMOTE_CWD)).sessions); }
  async function loadSession(client: AcpWebClient, session: SessionInfo) {
    const operationId = crypto.randomUUID();
    const store = useAppStore.getState();
    store.dispatchChat({ type: "session/open", sessionId: session.sessionId });
    store.dispatchChat({ type: "stream/start", operationId, source: "load", turnId: `load:${operationId}` });
    await client.load(session.sessionId, session.cwd);
    store.dispatchChat({ type: "stream/commit", operationId });
  }
  async function createSession() {
    const client = clientRef.current; if (!client) return;
    try { useAppStore.getState().setError(""); const created = await client.create(REMOTE_CWD); useAppStore.getState().dispatchChat({ type: "session/open", sessionId: created.sessionId }); await refreshSessions(client); }
    catch (cause) { useAppStore.getState().setError(errorText(cause)); }
  }
  async function selectSession(session: SessionInfo) {
    const client = clientRef.current; if (!client || session.sessionId === useAppStore.getState().chat.sessionId) return;
    try { useAppStore.getState().setError(""); await loadSession(client, session); } catch (cause) { useAppStore.getState().setError(errorText(cause)); }
  }
  async function send(text: string) {
    const client = clientRef.current; const sessionId = useAppStore.getState().chat.sessionId; if (!client || !sessionId) return;
    const operationId = crypto.randomUUID(); const turnId = crypto.randomUUID(); const store = useAppStore.getState();
    store.dispatchChat({ type: "stream/start", operationId, source: "prompt", turnId, optimisticContent: [{ type: "text", text }] });
    store.setRunning(true); store.setError("");
    try { const response = await client.prompt(sessionId, text, { turnId }); store.dispatchChat({ type: "stream/commit", operationId, stopReason: response.stopReason }); await refreshSessions(client); }
    catch (cause) { store.dispatchChat({ type: "stream/commit", operationId }); store.setError(errorText(cause)); }
    finally { store.setRunning(false); }
  }
  function cancel() { cancelInteractions(); const client = clientRef.current; const id = useAppStore.getState().chat.sessionId; if (client && id) void client.cancel(id); }

  const activeInteraction = interactionOrder[0] ? interactionsById[interactionOrder[0]] : undefined;
  const ready = connection === "connected" && chat.sessionId !== null;
  return <main className="app-shell">
    <SessionSidebar sessions={sessions} activeId={chat.sessionId} disabled={!ready || running} onCreate={() => void createSession()} onSelect={(session) => void selectSession(session)} />
    <section className="chat-screen">
      <ChatHeader connection={connection} />
      <ChatViewport entries={chat.entries} streamingEntries={chat.streamingEntries} running={running} />
      <div className="composer-dock">
        {error && <div className="error-bar"><span>{error}</span>{connection === "disconnected" && <button type="button" onClick={() => location.reload()}>重新连接</button>}</div>}
        {activeInteraction && <InteractionPendingPanel key={activeInteraction.id} interaction={activeInteraction} queued={interactionOrder.length} onResolve={resolveInteraction} />}
        <Composer disabled={!ready} running={running} onSend={send} onCancel={cancel} />
      </div>
    </section>
  </main>;
}

function errorText(value: unknown) { return value instanceof Error ? value.message : "发生未知错误"; }
