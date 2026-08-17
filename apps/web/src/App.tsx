import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { SessionInfo } from "@agentclientprotocol/sdk";
import type * as acp from "@agentclientprotocol/sdk";
import type { ModelReasoningCapability, ReasoningProfile, TurnState } from "@kindergarten/contracts";
import { AcpWebClient } from "./acp/acp-client.js";
import { ChatViewport } from "./components/chat/ChatViewport.js";
import { Composer } from "./components/composer/Composer.js";
import { ComposerAgentMissingNotice, ComposerAvailabilityNotice } from "./components/errors/ComposerAvailabilityNotice.js";
import { InteractionPendingPanel } from "./components/interactions/InteractionPendingPanel.js";
import { ChatHeader } from "./components/layout/ChatHeader.js";
import { SessionSidebar } from "./components/layout/SessionSidebar.js";
import {
  isPromptTurnActive,
  type PendingInteractionState,
  type PromptTurnState,
  type TurnAction,
} from "./prompt-turn/prompt-turn-types.js";
import { useAppStore } from "./store/app-store.js";
import { controlApi } from "./api/control-api.js";
import { ArtifactPanel } from "./product/ArtifactPanel.js";
import { projectReasoningConfig } from "./reasoning/reasoning-config.js";
import { isMissingAgentError, projectSessionAvailability, type SessionAgentAvailability } from "./session/session-identity.js";
import { sessionResumeMeta } from "./chat/chat-resume.js";
import { clampArtifactWidth, defaultArtifactWidth } from "./session/artifact-split-pane.js";

const ACP_URL = import.meta.env.VITE_ACP_URL ?? "ws://127.0.0.1:7331/acp";
const REMOTE_CWD = "/workspace";

export default function App() {
  const connection = useAppStore((state) => state.connection);
  const sessions = useAppStore((state) => state.sessions);
  const chat = useAppStore((state) => state.chat);
  const promptTurn = useAppStore((state) => state.promptTurn);
  const clientRef = useRef<AcpWebClient | null>(null);
  const reconnectRef = useRef<(() => Promise<void>) | null>(null);
  const initialAction = useRef(readInitialAction());
  const [identity, setIdentity] = useState<SessionIdentity>({ agentName: "Agent", modelName: "ModelStudent", agentAvailability: "loading" });
  const [configOptions, setConfigOptions] = useState<acp.SessionConfigOption[]>([]);
  const [reasoningBusy, setReasoningBusy] = useState(false);
  const [artifactId, setArtifactId] = useState<string | null>(null);
  const [artifactWidth, setArtifactWidth] = useState(520);
  const [narrowView, setNarrowView] = useState<"artifact" | "chat">("artifact");
  const workspaceRef = useRef<HTMLDivElement>(null);
  const artifactWidthRef = useRef(artifactWidth);
  const artifactDragRef = useRef<{ pointerId: number; workspaceLeft: number; workspaceWidth: number } | null>(null);

  useEffect(() => {
    const open = (event: Event) => {
      const id = (event as CustomEvent<unknown>).detail;
      if (typeof id !== "string" || id.length === 0) return;
      const containerWidth = workspaceRef.current?.clientWidth;
      if (containerWidth) {
        const width = defaultArtifactWidth(containerWidth);
        artifactWidthRef.current = width;
        setArtifactWidth(width);
      }
      setArtifactId(id);
      setNarrowView("artifact");
    };
    window.addEventListener("mk-open-file-reference", open);
    return () => window.removeEventListener("mk-open-file-reference", open);
  }, []);

  useEffect(() => {
    const stop = (event: PointerEvent) => {
      const drag = artifactDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      artifactDragRef.current = null;
      document.body.classList.remove("artifact-resizing");
      setArtifactWidth(artifactWidthRef.current);
    };
    const move = (event: PointerEvent) => {
      const drag = artifactDragRef.current;
      const workspace = workspaceRef.current;
      if (!drag || !workspace || event.pointerId !== drag.pointerId) return;
      const width = clampArtifactWidth(event.clientX - drag.workspaceLeft, drag.workspaceWidth);
      artifactWidthRef.current = width;
      workspace.style.setProperty("--artifact-width", `${width}px`);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      artifactDragRef.current = null;
      document.body.classList.remove("artifact-resizing");
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let current: AcpWebClient | null = null;
    let opening = false;
    const store = useAppStore.getState;

    const connect = async (mode: "initial" | "resume"): Promise<void> => {
      if (opening || disposed) return;
      opening = true;
      store().setConnection({ phase: "connecting" });
      let opened: AcpWebClient | null = null;
      try {
        let client: AcpWebClient | null = null;
        client = await AcpWebClient.open(ACP_URL, {
          onUpdate: (value) => {
            store().dispatchChat({ type: "acp/update", value });
            if (value.sessionId === store().chat.sessionId && value.update.sessionUpdate === "config_option_update") {
              setConfigOptions(value.update.configOptions);
            }
          },
          onContextSummary: (value) => store().dispatchChat({
            type: "context/summary",
            value,
          }),
          onTokenUsage: (value) => store().dispatchChat({
            type: "token/usage",
            value,
          }),
          onTurnState: (value) => {
            const before = store().promptTurn;
            if (value.sessionId !== store().chat.sessionId) {
              console.warn("[turn-machine] ignored state for inactive session", {
                sessionId: value.sessionId,
                activeSessionId: store().chat.sessionId,
                turnId: value.turn.turnId,
                remote: remoteTurnLogFacts(value.turn),
              });
              return;
            }
            store().dispatchPromptTurn({
              type: "turn/remote-state",
              sessionId: value.sessionId,
              turn: value.turn,
              restoredText: restoredTurnPrompt(store().chat, value.turn.turnId),
            });
            const after = store().promptTurn;
            console.warn("[turn-machine] remote transition", {
              sessionId: value.sessionId,
              turnId: value.turn.turnId,
              remote: remoteTurnLogFacts(value.turn),
              before: turnLogFacts(before),
              after: turnLogFacts(after),
            });
            if (
              value.turn.status !== "active" &&
              before.status !== "idle" &&
              before.request.sessionId === value.sessionId &&
              before.request.turnId === value.turn.turnId
            ) {
              store().dispatchChat({ type: "stream/commit", operationId: before.request.operationId });
            }
          },
          onInteraction: (interaction) => {
            const before = store().promptTurn;
            store().dispatchPromptTurn({ type: "interaction/enqueue", interaction });
            console.warn("[turn-machine] interaction enqueued", {
              interactionId: interaction.id,
              kind: interaction.kind,
              before: turnLogFacts(before),
              after: turnLogFacts(store().promptTurn),
            });
          },
          onInteractionResolved: (id) => {
            const before = store().promptTurn;
            store().dispatchPromptTurn({ type: "interaction/remove", id });
            console.warn("[turn-machine] interaction removed", {
              interactionId: id,
              before: turnLogFacts(before),
              after: turnLogFacts(store().promptTurn),
            });
          },
          onClose: () => {
            if (disposed || current !== client) return;
            current = null;
            clientRef.current = null;
            store().setConnection({
              phase: "disconnected",
              message: "ACP Remote 连接已断开",
            });
          },
        });
        opened = client;

        if (disposed) {
          client.close();
          return;
        }
        current = client;
        clientRef.current = client;

        if (mode === "resume") {
          const state = store();
          const sessionId = state.chat.sessionId;
          if (!sessionId) throw new Error("当前没有可以恢复的 Session");
          const turn = state.promptTurn;
          const response = await client.resume(
            sessionId,
            REMOTE_CWD,
            turn.status === "idle" ? undefined : sessionResumeMeta(state.chat, turn.request.turnId),
          );
          setConfigOptions(response.configOptions ?? []);
          await refreshSessions(client);
          await loadIdentity(sessionId);
          store().setConnection({ phase: "connected" });
        } else {
          store().setConnection({ phase: "connected" });
          const result = await client.list(REMOTE_CWD);
          store().setSessions(result.sessions);
          const action = initialAction.current;
          const requested = action.kind === "load" ? result.sessions.find((item) => item.sessionId === action.sessionId) : undefined;
          if (requested) {
            await loadSession(client, requested);
            replaceSessionUrl(requested.sessionId);
            await loadIdentity(requested.sessionId);
          } else if (action.kind === "launch") {
            const remembered = rememberedLaunchSession(action.launchId, result.sessions);
            if (remembered) {
              await loadSession(client, remembered);
              replaceSessionUrl(remembered.sessionId);
              await loadIdentity(remembered.sessionId);
              return;
            }
            const launch = await controlApi.sessionLaunch(action.launchId);
            const created = await client.create(REMOTE_CWD, { modelStudentId: launch.modelStudentId, agentId: launch.agentId });
            rememberLaunchSession(action.launchId, created.sessionId);
            openEmptySession(created.sessionId);
            setConfigOptions(created.configOptions ?? []);
            replaceSessionUrl(created.sessionId);
            await refreshSessions(client);
            await loadIdentity(created.sessionId);
            if (launch.reasoningProfileOverride) {
              const configId = thoughtLevelConfigId(created.configOptions ?? []);
              if (!configId) throw new Error("当前 Session 没有提供思考强度配置");
              const configured = await client.setConfigOption(created.sessionId, configId, launch.reasoningProfileOverride);
              setConfigOptions(configured.configOptions);
            }
            await send(launch.promptText);
          } else {
            const first = result.sessions[0];
            if (first) {
              await loadSession(client, first);
              replaceSessionUrl(first.sessionId);
              await loadIdentity(first.sessionId);
            }
          }
        }
      } catch (cause) {
        if (!disposed) {
          if (opened && current === opened) {
            current = null;
            clientRef.current = null;
            opened.close();
          }
          store().setConnection({
            phase: "disconnected",
            message: errorMessage(cause),
          });
        }
      } finally {
        opening = false;
      }
    };

    const navigate = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target || anchor.download) return;
      const target = new URL(anchor.href, location.href);
      if (target.origin !== location.origin || target.href === location.href) return;
      event.preventDefault();
      void closeCurrentSession(current).finally(() => { location.href = target.href; });
    };
    const pagehide = () => {
      current?.close();
    };

    reconnectRef.current = () => connect("resume");
    document.addEventListener("click", navigate);
    window.addEventListener("pagehide", pagehide);
    void connect("initial");

    return () => {
      disposed = true;
      reconnectRef.current = null;
      document.removeEventListener("click", navigate);
      window.removeEventListener("pagehide", pagehide);
      current?.close();
      clientRef.current = null;
    };
  }, []);

  function openEmptySession(sessionId: string): void {
    const store = useAppStore.getState();
    store.dispatchPromptTurn({ type: "turn/reset" });
    store.dispatchChat({ type: "session/open", sessionId });
    setConfigOptions([]);
    setReasoningBusy(false);
    setIdentity((current) => ({ ...current, agentAvailability: "loading" }));
  }

  async function refreshSessions(client = clientRef.current): Promise<void> {
    if (!client) return;
    const result = await client.list(REMOTE_CWD);
    useAppStore.getState().setSessions(result.sessions);
  }

  async function loadSession(client: AcpWebClient, session: SessionInfo): Promise<void> {
    const operationId = crypto.randomUUID();
    const store = useAppStore.getState();
    setIdentity((current) => ({ ...current, agentAvailability: "loading" }));
    store.dispatchPromptTurn({ type: "turn/reset" });
    store.dispatchChat({ type: "session/open", sessionId: session.sessionId });
    store.dispatchChat({
      type: "stream/start",
      operationId,
      source: "load",
      turnId: `load:${operationId}`,
    });
    try {
      const response = await client.load(session.sessionId, session.cwd);
      setConfigOptions(response.configOptions ?? []);
    } finally {
      // load 的通知也使用 streamingChatEntries，结束时必须统一提交或清理。
      store.dispatchChat({ type: "stream/commit", operationId });
    }
  }

  async function createSession(): Promise<void> {
    await closeCurrentSession();
    location.href = "/";
  }

  async function selectSession(session: SessionInfo): Promise<void> {
    const client = clientRef.current;
    if (!client || session.sessionId === useAppStore.getState().chat.sessionId) return;
    try {
      await closeCurrentSession(client);
      await loadSession(client, session);
      replaceSessionUrl(session.sessionId);
      await loadIdentity(session.sessionId);
    } catch (cause) {
      // V1.6 不引入另一套全局错误中心；保留诊断信息且不污染当前 Turn。
      console.error("加载 Session 失败", cause);
    }
  }

  async function loadIdentity(sessionId: string): Promise<void> {
    setIdentity((current) => ({ ...current, agentAvailability: "loading" }));
    try {
      const session = await fetchSessionIdentity(sessionId);
      const models = await controlApi.models();
      const model = models.items.find((item) => item.modelStudentId === session.modelStudentId);
      let agent: Awaited<ReturnType<typeof controlApi.agent>>;
      try {
        agent = await controlApi.agent(session.agentId);
      } catch (error) {
        if (!isMissingAgentError(error)) throw error;
        setIdentity({
          agentName: "Agent 已删除",
          modelName: model?.displayName ?? session.modelStudentId,
          agentAvailability: "missing",
          ...(model?.contextWindowTokens !== undefined ? { contextWindowTokens: model.contextWindowTokens } : {}),
          ...(model ? { reasoningCapability: model.supports.reasoning } : {}),
        });
        return;
      }
      setIdentity({
        agentName: agent.name,
        modelName: model?.displayName ?? session.modelStudentId,
        agentAvailability: "available",
        ...(model?.contextWindowTokens !== undefined ? { contextWindowTokens: model.contextWindowTokens } : {}),
        ...(model ? { reasoningCapability: model.supports.reasoning } : {}),
      });
    } catch (error) { console.error("读取 Session 身份失败", error); }
  }

  async function changeReasoning(profile: ReasoningProfile): Promise<void> {
    const client = clientRef.current;
    const sessionId = useAppStore.getState().chat.sessionId;
    const reasoning = projectReasoningConfig(configOptions, identity.reasoningCapability);
    if (!client || !sessionId || !reasoning || reasoningBusy || isPromptTurnActive(useAppStore.getState().promptTurn)) return;
    setReasoningBusy(true);
    try {
      const response = await client.setConfigOption(sessionId, reasoning.configId, profile);
      setConfigOptions(response.configOptions);
    } catch (error) {
      console.error("更新当前 Session 思考强度失败", error);
    } finally {
      setReasoningBusy(false);
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
      const turn = store.promptTurn;
      if (
        (store.connection.phase === "disconnected" || clientRef.current !== client) &&
        isPromptTurnActive(turn) &&
        turn.request.operationId === operationId
      ) return;
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
      reconnectCurrentSession();
      return;
    }
    const state = useAppStore.getState().promptTurn;
    if (state.status === "failed") void send(state.request.text);
  }

  const active = isPromptTurnActive(promptTurn);
  const interactionState = promptTurn.status === "active" && promptTurn.interactions.order.length > 0
    ? promptTurn.interactions
    : undefined;
  const activeInteractionId = interactionState?.order[0];
  const activeInteraction = activeInteractionId
    ? interactionState?.byId[activeInteractionId]
    : undefined;
  const availability = projectSessionAvailability(
    connection.phase === "connected",
    chat.sessionId !== null,
    identity.agentAvailability,
  );
  const reasoning = projectReasoningConfig(configOptions, identity.reasoningCapability);
  const workspaceStyle = { "--artifact-width": `${artifactWidth}px` } as CSSProperties;

  function startArtifactResize(event: ReactPointerEvent<HTMLDivElement>): void {
    const workspace = workspaceRef.current;
    if (!workspace || event.button !== 0) return;
    event.preventDefault();
    const rect = workspace.getBoundingClientRect();
    artifactDragRef.current = {
      pointerId: event.pointerId,
      workspaceLeft: rect.left,
      workspaceWidth: rect.width,
    };
    document.body.classList.add("artifact-resizing");
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  return <main className="app-shell">
    <SessionSidebar
      sessions={sessions}
      activeId={chat.sessionId}
      disabled={!availability.navigationEnabled || active}
      onCreate={() => void createSession()}
      onSelect={(session) => void selectSession(session)}
    />
    <section className={`session-main ${artifactId ? "has-artifact" : ""}`}>
      {artifactId && <div aria-label="窄屏视图" className="session-narrow-switch">
        <button className={narrowView === "artifact" ? "active" : ""} type="button" onClick={() => setNarrowView("artifact")}>产物</button>
        <button className={narrowView === "chat" ? "active" : ""} type="button" onClick={() => setNarrowView("chat")}>聊天</button>
      </div>}
      <div className={`session-workspace narrow-${narrowView}`} ref={workspaceRef} style={workspaceStyle}>
        {artifactId && <ArtifactPanel fileReferenceId={artifactId} onClose={() => setArtifactId(null)} />}
        {artifactId && <div
          aria-label="调整产物与聊天宽度"
          aria-orientation="vertical"
          className="artifact-resizer"
          onPointerDown={startArtifactResize}
          role="separator"
        ><ChevronLeft size={10} /><ChevronRight size={10} /></div>}
        <section className="chat-screen">
          <ChatHeader connection={connection} identity={identity} />
          <ChatViewport
            historyChatEntries={chat.historyChatEntries}
            streamingChatEntries={chat.streamingChatEntries}
            promptTurn={promptTurn}
            onTurnAction={handleTurnAction}
          />
          <div className="composer-dock">
            {connection.phase === "disconnected" && <ComposerAvailabilityNotice
              connection={connection}
              onReconnect={reconnectCurrentSession}
            />}
            {identity.agentAvailability === "missing" && <ComposerAgentMissingNotice />}
            {activeInteraction && interactionState && <InteractionPendingPanel
              key={activeInteraction.id}
              interaction={activeInteraction}
              queued={interactionState.order.length}
              onResolve={resolveInteraction}
            />}
            <Composer
              disabled={!availability.promptEnabled}
              running={active}
              {...(reasoning ? { reasoning } : {})}
              {...(identity.reasoningCapability ? { reasoningCapability: identity.reasoningCapability } : {})}
              reasoningBusy={reasoningBusy}
              onReasoningChange={(profile) => void changeReasoning(profile)}
              onSend={send}
              onCancel={cancel}
            />
          </div>
        </section>
      </div>
    </section>
  </main>;

  function reconnectCurrentSession(): void {
    void reconnectRef.current?.();
  }

  async function closeCurrentSession(client = clientRef.current): Promise<void> {
    const sessionId = useAppStore.getState().chat.sessionId;
    if (!client || !sessionId) return;
    try {
      await client.closeSession(sessionId);
    } catch (error) {
      console.warn("关闭 Session 失败", error);
    }
  }
}

type InitialAction = { kind: "load"; sessionId: string } | { kind: "launch"; launchId: string } | { kind: "latest" };
interface SessionIdentity {
  agentName: string;
  modelName: string;
  agentAvailability: SessionAgentAvailability;
  contextWindowTokens?: number;
  reasoningCapability?: ModelReasoningCapability;
}
function readInitialAction(): InitialAction {
  const query = new URLSearchParams(location.search);
  const pathSessionId = location.pathname.match(/^\/sessions\/([^/]+)\/?$/)?.[1];
  if (pathSessionId) return { kind: "load", sessionId: decodeURIComponent(pathSessionId) };
  const sessionId = query.get("sessionId");
  if (sessionId) return { kind: "load", sessionId };
  const launchId = query.get("launchId");
  if (launchId) return { kind: "launch", launchId };
  return { kind: "latest" };
}

function replaceSessionUrl(sessionId: string): void {
  history.replaceState(null, "", `/sessions/${encodeURIComponent(sessionId)}`);
}

function rememberLaunchSession(launchId: string, sessionId: string): void {
  sessionStorage.setItem(`mk-launch-session:${launchId}`, sessionId);
}

function rememberedLaunchSession(launchId: string, sessions: SessionInfo[]): SessionInfo | undefined {
  const sessionId = sessionStorage.getItem(`mk-launch-session:${launchId}`);
  return sessionId ? sessions.find((item) => item.sessionId === sessionId) : undefined;
}
async function fetchSessionIdentity(sessionId: string): Promise<{ modelStudentId: string; agentId: string }> {
  const base = import.meta.env.VITE_CONTROL_API_URL ?? "http://127.0.0.1:7331/api/control/v1";
  const response = await fetch(`${base}/sessions/${encodeURIComponent(sessionId)}`);
  const value = await response.json() as { data?: { modelStudentId: string; agentId: string }; detail?: string };
  if (!response.ok || !value.data) throw new Error(value.detail ?? "Session 不存在");
  return value.data;
}

function errorMessage(value: unknown): string {
  if (value instanceof Error && value.message.trim()) return value.message;
  if (typeof value === "string" && value.trim()) return value;
  return "发生未知错误";
}

function thoughtLevelConfigId(options: acp.SessionConfigOption[]): string | undefined {
  return options.find((option) => option.type === "select" && option.category === "thought_level")?.id;
}

function turnLogFacts(state: PromptTurnState) {
  if (state.status === "idle") return { status: state.status };
  return {
    status: state.status,
    sessionId: state.request.sessionId,
    turnId: state.request.turnId,
    ...(state.status === "active"
      ? {
          phase: state.phase,
          waitingFor: state.waitingFor,
          pendingInteractionIds: state.pendingInteractions.map((interaction) => interaction.interactionId),
          interactionCount: state.interactions.order.length,
        }
      : {}),
  };
}

function remoteTurnLogFacts(state: TurnState) {
  return state.status === "active"
    ? {
        status: state.status,
        phase: state.phase,
        waitingFor: state.waitingFor,
        pendingInteractions: state.pendingInteractions.map((interaction) => ({
          interactionId: interaction.interactionId,
          kind: interaction.kind,
          toolCallId: interaction.kind === "permission" ? interaction.toolCall.toolCallId : interaction.toolCallId,
          ...(interaction.kind === "permission" ? { toolName: interaction.toolCall.name } : {}),
        })),
      }
    : { status: state.status };
}

function restoredTurnPrompt(chat: ReturnType<typeof useAppStore.getState>["chat"], turnId: string): string {
  for (const collection of [chat.streamingChatEntries, chat.historyChatEntries]) {
    for (let index = collection.order.length - 1; index >= 0; index -= 1) {
      const entry = collection.byId[collection.order[index]!];
      if (entry?.type !== "message" || entry.role !== "user" || entry.turnId !== turnId) continue;
      return entry.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
    }
  }
  return "";
}
