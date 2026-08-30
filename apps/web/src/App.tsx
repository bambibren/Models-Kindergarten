import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { SessionInfo } from "@agentclientprotocol/sdk";
import type * as acp from "@agentclientprotocol/sdk";
import { PRODUCT_CONFIG, type ArtifactMentionInput, type ModelReasoningCapability, type ReasoningProfile, type TurnState } from "@kindergarten/contracts";
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
import { PublishedArtifactPanel } from "./product/PublishedArtifactPanel.js";
import { projectReasoningConfig } from "./reasoning/reasoning-config.js";
import { isMissingAgentError, projectSessionAvailability, type SessionAgentAvailability } from "./session/session-identity.js";
import { sessionResumeMeta } from "./chat/chat-resume.js";
import { clampArtifactWidth, defaultArtifactWidth } from "./session/artifact-split-pane.js";
import { selectContextWindowUsage } from "./chat/context-window-usage.js";
import { projectSessionTurnPage } from "./chat/session-history-page.js";
import { acpWebSocketUrl, CONTROL_API_URL } from "./deployment-endpoints.js";

const ACP_URL = acpWebSocketUrl();
const REMOTE_CWD = "/workspace";

/** 渲染「App」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export default function App() {
  const connection = useAppStore(/** 执行「connection」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(state) => state.connection);
  const sessions = useAppStore(/** 执行「sessions」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(state) => state.sessions);
  const chat = useAppStore(/** 执行「chat」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(state) => state.chat);
  const promptTurn = useAppStore(/** 执行「promptTurn」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(state) => state.promptTurn);
  const contextWindowUsage = selectContextWindowUsage(chat.historyChatEntries, chat.streamingChatEntries);
  const clientRef = useRef<AcpWebClient | null>(null);
  const reconnectRef = useRef<(() => Promise<void>) | null>(null);
  const initialAction = useRef(readInitialAction());
  const [identity, setIdentity] = useState<SessionIdentity>({ agentName: "Agent", modelName: "ModelStudent", agentAvailability: "loading" });
  const [configOptions, setConfigOptions] = useState<acp.SessionConfigOption[]>([]);
  const [reasoningBusy, setReasoningBusy] = useState(false);
  const [publishedArtifactId, setPublishedArtifactId] = useState<string | null>(null);
  const [artifactWidth, setArtifactWidth] = useState(520);
  const [narrowView, setNarrowView] = useState<"artifact" | "chat">("artifact");
  const [historyPaging, setHistoryPaging] = useState<{
    loading: boolean;
    hasMore: boolean;
    nextBeforeTurnId?: string;
  }>({ loading: false, hasMore: false });
  const workspaceRef = useRef<HTMLDivElement>(null);
  const artifactWidthRef = useRef(artifactWidth);
  const artifactDragRef = useRef<{ pointerId: number; workspaceLeft: number; workspaceWidth: number } | null>(null);

  useEffect(/** 同步组件生命周期内的外部状态，并在清理阶段释放订阅或临时资源。 */
() => {
    const open = /** 执行「open」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(event: Event) => {
      const id = (event as CustomEvent<unknown>).detail;
      if (typeof id !== "string" || id.length === 0) return;
      const containerWidth = workspaceRef.current?.clientWidth;
      if (containerWidth) {
        const width = defaultArtifactWidth(containerWidth);
        artifactWidthRef.current = width;
        setArtifactWidth(width);
      }
      setPublishedArtifactId(id);
      setNarrowView("artifact");
    };
    window.addEventListener("mk-open-artifact", open);
    return /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */ () => window.removeEventListener("mk-open-artifact", open);
  }, []);

  useEffect(/** 同步组件生命周期内的外部状态，并在清理阶段释放订阅或临时资源。 */
() => {
    const stop = /** 执行「stop」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(event: PointerEvent) => {
      const drag = artifactDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      artifactDragRef.current = null;
      document.body.classList.remove("artifact-resizing");
      setArtifactWidth(artifactWidthRef.current);
    };
    const move = /** 执行「move」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(event: PointerEvent) => {
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
    return /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */ () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      artifactDragRef.current = null;
      document.body.classList.remove("artifact-resizing");
    };
  }, []);

  useEffect(/** 同步组件生命周期内的外部状态，并在清理阶段释放订阅或临时资源。 */
() => {
    let disposed = false;
    let current: AcpWebClient | null = null;
    let opening = false;
    const store = useAppStore.getState;

    const connect = /** 执行「connect」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async (mode: "initial" | "resume"): Promise<void> => {
      if (opening || disposed) return;
      opening = true;
      store().setConnection({ phase: "connecting" });
      let opened: AcpWebClient | null = null;
      try {
        let client: AcpWebClient | null = null;
        client = await AcpWebClient.open(ACP_URL, {
          onUpdate: /** 处理「onUpdate」事件，校验归属后再推进状态且避免重复提交。 */
(value) => {
            store().dispatchChat({ type: "acp/update", value });
            if (value.sessionId === store().chat.sessionId && value.update.sessionUpdate === "config_option_update") {
              setConfigOptions(value.update.configOptions);
            }
          },
          onContextSummary: /** 处理「onContextSummary」事件，校验归属后再推进状态且避免重复提交。 */
(value) => store().dispatchChat({
            type: "context/summary",
            value,
          }),
          onTokenUsage: /** 处理「onTokenUsage」事件，校验归属后再推进状态且避免重复提交。 */
(value) => store().dispatchChat({
            type: "token/usage",
            value,
          }),
          onContextWindowUsage: /** 处理「onContextWindowUsage」事件，校验归属后再推进状态且避免重复提交。 */
(value) => store().dispatchChat({
            type: "context-window/usage",
            value,
          }),
          onTurnState: /** 处理「onTurnState」事件，校验归属后再推进状态且避免重复提交。 */
(value) => {
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
              restoredArtifactMentions: restoredTurnArtifactMentions(store().chat, value.turn.turnId),
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
          onInteraction: /** 处理「onInteraction」事件，校验归属后再推进状态且避免重复提交。 */
(interaction) => {
            const before = store().promptTurn;
            store().dispatchPromptTurn({ type: "interaction/enqueue", interaction });
            console.warn("[turn-machine] interaction enqueued", {
              interactionId: interaction.id,
              kind: interaction.kind,
              before: turnLogFacts(before),
              after: turnLogFacts(store().promptTurn),
            });
          },
          onInteractionResolved: /** 处理「onInteractionResolved」事件，校验归属后再推进状态且避免重复提交。 */
(id) => {
            const before = store().promptTurn;
            store().dispatchPromptTurn({ type: "interaction/remove", id });
            console.warn("[turn-machine] interaction removed", {
              interactionId: id,
              before: turnLogFacts(before),
              after: turnLogFacts(store().promptTurn),
            });
          },
          onClose: /** 处理「onClose」事件，校验归属后再推进状态且避免重复提交。 */
() => {
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
          const requested = action.kind === "load" ? result.sessions.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.sessionId === action.sessionId) : undefined;
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
            await send(launch.promptText, launch.artifactMentions ?? []);
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

    const navigate = /** 执行「navigate」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target || anchor.download) return;
      const target = new URL(anchor.href, location.href);
      if (target.origin !== location.origin || target.href === location.href) return;
      event.preventDefault();
      void closeCurrentSession(current).finally(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => { location.href = target.href; });
    };
    const pagehide = /** 执行「pagehide」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => {
      current?.close();
    };

    reconnectRef.current = /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
() => connect("resume");
    document.addEventListener("click", navigate);
    window.addEventListener("pagehide", pagehide);
    void connect("initial");

    return /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */ () => {
      disposed = true;
      reconnectRef.current = null;
      document.removeEventListener("click", navigate);
      window.removeEventListener("pagehide", pagehide);
      current?.close();
      clientRef.current = null;
    };
  }, []);

  /** 执行「openEmptySession」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function openEmptySession(sessionId: string): void {
    const store = useAppStore.getState();
    store.dispatchPromptTurn({ type: "turn/reset" });
    store.dispatchChat({ type: "session/open", sessionId });
    setConfigOptions([]);
    setReasoningBusy(false);
    setHistoryPaging({ loading: false, hasMore: false });
    setIdentity(/** 执行「openEmptySession」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(current) => ({ ...current, agentAvailability: "loading" }));
  }

  /** 执行「refreshSessions」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async function refreshSessions(client = clientRef.current): Promise<void> {
    if (!client) return;
    const result = await client.list(REMOTE_CWD);
    useAppStore.getState().setSessions(result.sessions);
  }

  /** 读取「loadSession」所需数据，并遵守作用域、分页与容量边界。 */
async function loadSession(client: AcpWebClient, session: SessionInfo): Promise<void> {
    const operationId = crypto.randomUUID();
    const store = useAppStore.getState();
    setIdentity(/** 读取「loadSession」所需数据，并遵守作用域、分页与容量边界。 */
(current) => ({ ...current, agentAvailability: "loading" }));
    store.dispatchPromptTurn({ type: "turn/reset" });
    store.dispatchChat({ type: "session/open", sessionId: session.sessionId });
    store.dispatchChat({
      type: "stream/start",
      operationId,
      source: "load",
      turnId: `load:${operationId}`,
    });
    try {
      const [response, page] = await Promise.all([
        client.load(session.sessionId, session.cwd),
        controlApi.sessionTurns(session.sessionId),
      ]);
      setConfigOptions(response.configOptions ?? []);
      setHistoryPaging({
        loading: false,
        hasMore: page.hasMore,
        ...(page.nextBeforeTurnId ? { nextBeforeTurnId: page.nextBeforeTurnId } : {}),
      });
    } finally {
      const current = useAppStore.getState();
      const turn = current.promptTurn;
      // load 回放提交为历史；活动 Turn 同一原子转换续接实时流，避免授权后的增量落入空窗口。
      current.dispatchChat({
        type: "stream/load-complete",
        operationId,
        ...(turn.status === "active" && turn.request.sessionId === session.sessionId
          ? { activeTurn: { operationId: turn.request.operationId, turnId: turn.request.turnId } }
          : {}),
      });
    }
  }

  /** 只读加载更早一页；模型 historyPolicy 与该 UI 分页完全独立。 */
  async function loadOlderHistory(): Promise<void> {
    const sessionId = useAppStore.getState().chat.sessionId;
    if (!sessionId || historyPaging.loading || !historyPaging.hasMore || !historyPaging.nextBeforeTurnId) return;
    setHistoryPaging(/** 读取「loadOlderHistory」所需数据，并遵守作用域、分页与容量边界。 */
(current) => ({ ...current, loading: true }));
    try {
      const page = await controlApi.sessionTurns(sessionId, historyPaging.nextBeforeTurnId);
      const store = useAppStore.getState();
      if (store.chat.sessionId !== sessionId) return;
      store.dispatchChat({
        type: "history/prepend",
        entries: projectSessionTurnPage(page),
        maxTurns: PRODUCT_CONFIG.agent.maxWebRetainedTurns,
      });
      const currentChat = useAppStore.getState().chat;
      const retainedTurns = new Set(currentChat.historyChatEntries.order.flatMap(/** 执行「size」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(id) => {
        const turnId = currentChat.historyChatEntries.byId[id]?.turnId;
        return turnId ? [turnId] : [];
      })).size;
      const atLimit = retainedTurns >= PRODUCT_CONFIG.agent.maxWebRetainedTurns;
      setHistoryPaging({
        loading: false,
        hasMore: page.hasMore && !atLimit,
        ...(!atLimit && page.nextBeforeTurnId ? { nextBeforeTurnId: page.nextBeforeTurnId } : {}),
      });
    } catch (error) {
      console.error("加载更早的 Session 历史失败", error);
      setHistoryPaging(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(current) => ({ ...current, loading: false }));
    }
  }

  /** 根据已校验输入构建「createSession」结果，不额外持有调用方的大对象。 */
async function createSession(): Promise<void> {
    await closeCurrentSession();
    location.href = "/";
  }

  /** 执行「selectSession」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
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

  /** 读取「loadIdentity」所需数据，并遵守作用域、分页与容量边界。 */
async function loadIdentity(sessionId: string): Promise<void> {
    setIdentity(/** 读取「loadIdentity」所需数据，并遵守作用域、分页与容量边界。 */
(current) => ({ ...current, agentAvailability: "loading" }));
    try {
      const session = await fetchSessionIdentity(sessionId);
      const models = await controlApi.models();
      const model = models.items.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.modelStudentId === session.modelStudentId);
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

  /** 执行「changeReasoning」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
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

  /** 执行「send」主流程，传播取消与失败并在结束时清理临时资源。 */
async function send(text: string, artifactMentions: ArtifactMentionInput[] = [], retryOperationId?: string): Promise<boolean> {
    const client = clientRef.current;
    const state = useAppStore.getState();
    const sessionId = state.chat.sessionId;
    if (!client || !sessionId || isPromptTurnActive(state.promptTurn)) return false;

    const operationId = retryOperationId ?? crypto.randomUUID();
    const turnId = crypto.randomUUID();
    const request = { operationId, sessionId, turnId, text, ...(artifactMentions.length ? { artifactMentions } : {}) };
    state.dispatchChat({
      type: "stream/start",
      operationId,
      source: "prompt",
      turnId,
      optimisticContent: [{ type: "text", text }],
    });
    state.dispatchPromptTurn({ type: "turn/start", request });

    try {
      const response = await client.prompt(sessionId, text, { turnId, operationId, ...(artifactMentions.length ? { artifactMentions } : {}) });
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
      void refreshSessions(client).catch(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
(cause: unknown) => {
        console.error("刷新 Session 列表失败", cause);
      });
      return true;
    } catch (cause) {
      const store = useAppStore.getState();
      const turn = store.promptTurn;
      if (
        (store.connection.phase === "disconnected" || clientRef.current !== client) &&
        isPromptTurnActive(turn) &&
        turn.request.operationId === operationId
      ) return false;
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
      return false;
    }
  }

  /** 判断「cancel」对应条件，只返回判定结果且不修改输入状态。 */
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

  /** 执行「resolveInteraction」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function resolveInteraction(
    interaction: PendingInteractionState,
    value: acp.RequestPermissionResponse | acp.CreateElicitationResponse,
  ): void {
    clientRef.current?.resolveInteraction(interaction, value);
  }

  /** 处理「handleTurnAction」事件，校验归属后再推进状态且避免重复提交。 */
function handleTurnAction(action: TurnAction): void {
    if (action.type === "reconnect") {
      reconnectCurrentSession();
      return;
    }
    const state = useAppStore.getState().promptTurn;
    if (state.status === "failed" || state.status === "interrupted") {
      void send(state.request.text, state.request.artifactMentions ?? [], state.request.operationId);
    }
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
  const hasArtifact = Boolean(publishedArtifactId);

  /** 执行「startArtifactResize」主流程，传播取消与失败并在结束时清理临时资源。 */
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
      onCreate={/** 处理「onCreate」事件，校验归属后再推进状态且避免重复提交。 */
() => void createSession()}
      onSelect={/** 处理「onSelect」事件，校验归属后再推进状态且避免重复提交。 */
(session) => void selectSession(session)}
    />
    <section className={`session-main ${hasArtifact ? "has-artifact" : ""}`}>
      {hasArtifact && <div aria-label="窄屏视图" className="session-narrow-switch">
        <button className={narrowView === "artifact" ? "active" : ""} type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => setNarrowView("artifact")}>产物</button>
        <button className={narrowView === "chat" ? "active" : ""} type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => setNarrowView("chat")}>聊天</button>
      </div>}
      <div className={`session-workspace narrow-${narrowView}`} ref={workspaceRef} style={workspaceStyle}>
        {publishedArtifactId && <PublishedArtifactPanel artifactId={publishedArtifactId} onClose={/** 处理「onClose」事件，校验归属后再推进状态且避免重复提交。 */
() => setPublishedArtifactId(null)} />}
        {hasArtifact && <div
          aria-label="调整产物与聊天宽度"
          aria-orientation="vertical"
          className="artifact-resizer"
          onPointerDown={startArtifactResize}
          role="separator"
        ><ChevronLeft size={10} /><ChevronRight size={10} /></div>}
        <section className="chat-screen">
          <ChatHeader connection={connection} identity={identity} />
          <ChatViewport
            historyPaging={historyPaging}
            historyChatEntries={chat.historyChatEntries}
            initializing={connection.phase === "connecting" || identity.agentAvailability === "loading"}
            streamingChatEntries={chat.streamingChatEntries}
            promptTurn={promptTurn}
            onTurnAction={handleTurnAction}
            onLoadOlder={/** 处理「onLoadOlder」事件，校验归属后再推进状态且避免重复提交。 */
() => void loadOlderHistory()}
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
              contextWindowUsage={contextWindowUsage}
              disabled={!availability.promptEnabled}
              running={active}
              {...(reasoning ? { reasoning } : {})}
              {...(identity.reasoningCapability ? { reasoningCapability: identity.reasoningCapability } : {})}
              reasoningBusy={reasoningBusy}
              onReasoningChange={/** 处理「onReasoningChange」事件，校验归属后再推进状态且避免重复提交。 */
(profile) => void changeReasoning(profile)}
              onSend={send}
              onCancel={cancel}
            />
          </div>
        </section>
      </div>
    </section>
  </main>;

  /** 执行「reconnectCurrentSession」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function reconnectCurrentSession(): void {
    void reconnectRef.current?.();
  }

  /** 释放或删除「closeCurrentSession」对应资源，重复调用仍保持安全。 */
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
/** 读取「readInitialAction」所需数据，并遵守作用域、分页与容量边界。 */
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

/** 执行「replaceSessionUrl」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function replaceSessionUrl(sessionId: string): void {
  history.replaceState(null, "", `/sessions/${encodeURIComponent(sessionId)}`);
}

/** 执行「rememberLaunchSession」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function rememberLaunchSession(launchId: string, sessionId: string): void {
  sessionStorage.setItem(`mk-launch-session:${launchId}`, sessionId);
}

/** 执行「rememberedLaunchSession」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function rememberedLaunchSession(launchId: string, sessions: SessionInfo[]): SessionInfo | undefined {
  const sessionId = sessionStorage.getItem(`mk-launch-session:${launchId}`);
  return sessionId ? sessions.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.sessionId === sessionId) : undefined;
}
/** 读取「fetchSessionIdentity」所需数据，并遵守作用域、分页与容量边界。 */
async function fetchSessionIdentity(sessionId: string): Promise<{ modelStudentId: string; agentId: string }> {
  const response = await fetch(`${CONTROL_API_URL}/sessions/${encodeURIComponent(sessionId)}`);
  const value = await response.json() as { data?: { modelStudentId: string; agentId: string }; detail?: string };
  if (!response.ok || !value.data) throw new Error(value.detail ?? "Session 不存在");
  return value.data;
}

/** 把未知异常转换为「errorMessage」文本，避免错误序列化过程再次抛出。 */
function errorMessage(value: unknown): string {
  if (value instanceof Error && value.message.trim()) return value.message;
  if (typeof value === "string" && value.trim()) return value;
  return "发生未知错误";
}

/** 由规范字段生成稳定的「thoughtLevelConfigId」标识，供索引精确定位且不保留原始大对象。 */
function thoughtLevelConfigId(options: acp.SessionConfigOption[]): string | undefined {
  return options.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(option) => option.type === "select" && option.category === "thought_level")?.id;
}

/** 生成「turnLogFacts」不可变视图，隔离后续状态修改并只暴露该层需要的事实。 */
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
          pendingInteractionIds: state.pendingInteractions.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(interaction) => interaction.interactionId),
          interactionCount: state.interactions.order.length,
        }
      : {}),
  };
}

/** 生成「remoteTurnLogFacts」不可变视图，隔离后续状态修改并只暴露该层需要的事实。 */
function remoteTurnLogFacts(state: TurnState) {
  return state.status === "active"
    ? {
        status: state.status,
        phase: state.phase,
        waitingFor: state.waitingFor,
        pendingInteractions: state.pendingInteractions.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(interaction) => ({
          interactionId: interaction.interactionId,
          kind: interaction.kind,
          toolCallId: interaction.kind === "permission" ? interaction.toolCall.toolCallId : interaction.toolCallId,
          ...(interaction.kind === "permission" ? { toolName: interaction.toolCall.name } : {}),
        })),
      }
    : { status: state.status };
}

/** 执行「restoredTurnPrompt」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function restoredTurnPrompt(chat: ReturnType<typeof useAppStore.getState>["chat"], turnId: string): string {
  for (const collection of [chat.streamingChatEntries, chat.historyChatEntries]) {
    for (let index = collection.order.length - 1; index >= 0; index -= 1) {
      const entry = collection.byId[collection.order[index]!];
      if (entry?.type !== "message" || entry.role !== "user" || entry.turnId !== turnId) continue;
      return entry.content.flatMap(/** 执行「join」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(block) => block.type === "text" ? [block.text] : []).join("");
    }
  }
  return "";
}

/** 执行「restoredTurnArtifactMentions」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function restoredTurnArtifactMentions(chat: ReturnType<typeof useAppStore.getState>["chat"], turnId: string): ArtifactMentionInput[] {
  for (const collection of [chat.streamingChatEntries, chat.historyChatEntries]) {
    for (let index = collection.order.length - 1; index >= 0; index -= 1) {
      const entry = collection.byId[collection.order[index]!];
      if (entry?.type !== "message" || entry.role !== "user" || entry.turnId !== turnId) continue;
      return (entry.artifactMentions ?? []).map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(mention) => ({ artifactId: mention.artifactId }));
    }
  }
  return [];
}
