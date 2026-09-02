import { randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import {
  readPromptMeta,
  readSessionResumeMeta,
  type SessionResumeMeta,
  type ContextSummary,
  type TokenUsageComponent,
  type TurnTokenUsage,
  isReasoningProfile,
  type ConcreteReasoningProfile,
  type ModelReasoningCapability,
  type TurnActivePhase,
  makeTurnInteractionId,
  type TurnPendingElicitationInteraction,
  type TurnPendingInteraction,
  type TurnPendingPermissionInteraction,
  type TurnState,
  type ArtifactMention,
  type ContextWindowUsageState,
  type LiveExecutionEvent,
  type LiveExecutionEventData,
  PRODUCT_CONFIG,
} from "@kindergarten/contracts";
import { AcpOutput } from "./acp-output.js";
import type {
  AgentRuntime,
  RunObserver,
  RuntimeModelAttemptSnapshot,
  RuntimeModelAttemptFailureSnapshot,
  RuntimeModelAttemptCompletionSnapshot,
  RuntimeModelRoundSnapshot,
  RuntimeTurnSnapshot,
  TurnModelUsage,
} from "../runtime/agent-runtime.js";
import {
  withProviderContinuationCorrelation,
  type ProviderOpaqueContinuation,
} from "../model/provider-continuation.js";
import type { SessionRepository } from "../repository/session-repository.js";
import type {
  SessionEntry,
  SessionContextSummaryEntry,
  SessionContextWindowUsageEntry,
  SessionMessageEntry,
  SessionRecord,
  SessionTokenUsageEntry,
  SessionThoughtEntry,
  SessionToolCallEntry,
} from "../repository/session-types.js";
import type { PreparedToolCall, ToolOutcome } from "../tools/tool-registry.js";
import type {
  ModelOutputItemCompleted,
  ModelOutputItemDelta,
  ModelOutputItemStarted,
} from "../model/model-provider.js";
import { RunFailure } from "../runtime/run-failure.js";
import type { SessionBindingService } from "../session/session-binding-service.js";
import { turnScope } from "../runtime/turn-scope.js";
import type { ExperimentService } from "../experiments/experiment-service.js";
import type { RuntimeCapabilitySnapshot } from "../capability/capability-types.js";
import type { ModelStudentCatalog } from "../model/model-student-catalog.js";
import { SessionAcpChannel } from "./session-acp-channel.js";
import type { ArtifactService } from "../artifacts/artifact-service.js";

const REASONING_CONFIG_ID = "reasoning_profile";

/** 执行「reasoningConfigOptions」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function reasoningConfigOptions(
  capability: ModelReasoningCapability | undefined,
  current: ConcreteReasoningProfile | undefined,
): acp.SessionConfigOption[] {
  if (!capability?.adjustable) return [];
  const labels: Record<ConcreteReasoningProfile, string> = {
    fast: capability.control === "toggle" ? "关闭思考" : "快速",
    balanced: capability.control === "toggle" ? "开启思考" : "均衡",
    deep: "深入",
    max: "极致",
  };
  return [{
    type: "select",
    id: REASONING_CONFIG_ID,
    name: capability.control === "toggle" ? "思考开关" : "思考强度",
    description: "当前会话的思考控制；自动表示跟随 ModelStudent 默认设置",
    category: "thought_level",
    currentValue: current ?? "auto",
    options: [
      { value: "auto", name: `跟随模型默认 · ${labels[capability.defaultProfile]}` },
      ...capability.supportedProfiles.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(profile) => ({ value: profile, name: labels[profile] })),
    ],
  }];
}

/** ACP Adapter 负责会话、双向用户交互和 ChatEntry 输出，不实现模型或文件逻辑。 */
export class KindergartenAgent {
  private readonly active = new Map<string, AbortController>();
  private readonly pendingPrompts = new Map<string, AbortController>();
  private readonly sessionStateOperations = new Map<string, Promise<unknown>>();
  private readonly channels = new Map<string, SessionAcpChannel>();
  private readonly projections = new Map<string, TurnProjection>();

  /** 初始化「KindergartenAgent」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(
    private readonly sessions: SessionRepository,
    private readonly runtime: AgentRuntime,
    private readonly bindings: SessionBindingService,
    private readonly experiments?: ExperimentService,
    private readonly models?: ModelStudentCatalog,
    private readonly artifacts?: ArtifactService,
    private readonly principalId = "local-admin",
  ) {}

  /** 根据已校验输入构建「createApp」结果，不额外持有调用方的大对象。 */
createApp(): acp.AgentApp {
    return acp
      .agent({ name: "model-kindergarten-remote" })
      .onRequest(acp.methods.agent.initialize, /** 处理「onRequest」事件，校验归属后再推进状态且避免重复提交。 */
({ params }) => this.initialize(params))
      .onRequest(acp.methods.agent.session.new, /** 处理「onRequest」事件，校验归属后再推进状态且避免重复提交。 */
({ params }) => this.newSession(params))
      .onRequest(acp.methods.agent.session.list, /** 处理「onRequest」事件，校验归属后再推进状态且避免重复提交。 */
({ params }) => this.listSessions(params))
      .onRequest(acp.methods.agent.session.load, /** 处理「onRequest」事件，校验归属后再推进状态且避免重复提交。 */
({ params, client }) =>
        this.loadSession(params, client),
      )
      .onRequest(acp.methods.agent.session.resume, /** 处理「onRequest」事件，校验归属后再推进状态且避免重复提交。 */
({ params, client }) =>
        this.resumeSession(params, client),
      )
      .onRequest(acp.methods.agent.session.close, /** 处理「onRequest」事件，校验归属后再推进状态且避免重复提交。 */
({ params }) =>
        this.closeSession(params),
      )
      .onRequest(acp.methods.agent.session.setConfigOption, /** 处理「onRequest」事件，校验归属后再推进状态且避免重复提交。 */
({ params }) =>
        this.setSessionConfigOption(params),
      )
      .onRequest(acp.methods.agent.session.prompt, /** 处理「onNotification」事件，校验归属后再推进状态且避免重复提交。 */
({ params, client, signal }) =>
        this.prompt(params, client, signal),
      )
      .onNotification(acp.methods.agent.session.cancel, /** 根据已校验输入构建「createApp」结果，不额外持有调用方的大对象。 */
async ({ params }) =>
        this.cancelOwned(params.sessionId),
      );
  }

  /** 执行「initialize」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
private initialize(params: acp.InitializeRequest): acp.InitializeResponse {
    return {
      protocolVersion:
        params.protocolVersion === acp.PROTOCOL_VERSION
          ? params.protocolVersion
          : acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        sessionCapabilities: { list: {}, resume: {}, close: {} },
      },
      agentInfo: {
        name: "models-kindergarten",
        title: "Models Kindergarten",
        version: "0.2.0",
      },
    };
  }

  /** 执行「newSession」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
private async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const session = await this.sessions.create(await this.bindings.resolve({
      cwd: params.cwd,
      ...(params.additionalDirectories === undefined ? {} : { additionalDirectories: params.additionalDirectories }),
      mcpServers: params.mcpServers,
      ...(params._meta === null || params._meta === undefined ? {} : { _meta: params._meta }),
    }));
    if (session.experimentRef && this.experiments) {
      await this.experiments.markSessionCreated(session.experimentRef.experimentId, session.experimentRef.variantId, session.id);
    }
    return { sessionId: session.id, configOptions: reasoningConfigOptions(this.reasoningCapability(session), session.reasoningOverride) };
  }

  /** 读取「listSessions」所需数据，并遵守作用域、分页与容量边界。 */
private async listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
    return { sessions: await this.sessions.list(params.cwd, "chat", this.principalId) };
  }

  /** 读取「loadSession」所需数据，并遵守作用域、分页与容量边界。 */
private async loadSession(
    params: acp.LoadSessionRequest,
    client: acp.AgentContext,
  ): Promise<acp.LoadSessionResponse> {
    // ACP load 只回放最近一页；更早的历史由只读 Control API 分页加载。
    const session = await this.requireSession(params.sessionId, params.cwd, PRODUCT_CONFIG.agent.historyPageTurns);
    const activeChannel = this.channels.get(session.id);
    activeChannel?.beginResume();
    const output = new AcpOutput(session.id, new SessionAcpChannel(client, session.id));
    try {
      for (const entry of sessionEntriesWithActiveProjection(session, this.projections.get(session.id))) {
        await replayEntry(output, entry);
      }
      const activeTurn = session.turns.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(turn) => turn.state.status === "active");
      if (activeTurn) await output.turnState(activeTurn.state);
    } finally {
      await activeChannel?.finishResume(client);
    }
    return { configOptions: reasoningConfigOptions(this.reasoningCapability(session), session.reasoningOverride) };
  }

  /** 根据客户端 Turn 游标只补断线增量；未提供游标时保持零回放并重新挂接活动交互。 */
private async resumeSession(
    params: acp.ResumeSessionRequest,
    client: acp.AgentContext,
  ): Promise<acp.ResumeSessionResponse> {
    // resume 仅关心仍在活动的最后一个 Turn，不承担历史加载。
    const session = await this.requireSession(params.sessionId, params.cwd, 1);
    const activeChannel = this.channels.get(session.id);
    activeChannel?.beginResume();
    try {
      const cursor = readSessionResumeMeta(params._meta);
      if (cursor) {
        const turn = session.turns.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.turnId === cursor.turnId);
        if (!turn) throw new acp.RequestError(-32602, `恢复的 Turn 不存在: ${cursor.turnId}`);
        const entries = sessionEntriesWithActiveProjection(session, this.projections.get(session.id))
          .filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(entry) => entry.turnId === cursor.turnId);
        const output = new AcpOutput(session.id, new SessionAcpChannel(client, session.id));
        for (const entry of entries) await replayEntryDelta(output, entry, cursor, turn.state.status !== "active");
        await output.turnState(turn.state);
      }
    } finally {
      await activeChannel?.finishResume(client);
    }
    return { configOptions: reasoningConfigOptions(this.reasoningCapability(session), session.reasoningOverride) };
  }

  /** 释放或删除「closeSession」对应资源，重复调用仍保持安全。 */
private async closeSession(params: acp.CloseSessionRequest): Promise<void> {
    await this.requireOwnedSession(params.sessionId, 0);
    this.cancel(params.sessionId);
    this.channels.get(params.sessionId)?.close();
  }

  /** 更新「setSessionConfigOption」对应状态，并保持写入顺序、原子性与容量约束。 */
private async setSessionConfigOption(
    params: acp.SetSessionConfigOptionRequest,
  ): Promise<acp.SetSessionConfigOptionResponse> {
    if (params.configId !== REASONING_CONFIG_ID || typeof params.value !== "string" || !isReasoningProfile(params.value)) {
      throw new acp.RequestError(-32602, "不支持的 Session Config Option");
    }
    const value = params.value;
    return this.serializeSessionState(params.sessionId, /** 更新「setSessionConfigOption」对应状态，并保持写入顺序、原子性与容量约束。 */
async () => {
      if (this.active.has(params.sessionId)) {
        throw new acp.RequestError(-32000, "回答生成期间不能修改思考强度");
      }
      const current = await this.sessions.getRecent(params.sessionId, 0);
      if (current.ownerId !== this.principalId) throw new Error("Session 不存在");
      const capability = this.reasoningCapability(current);
      if (!capability?.adjustable || (value !== "auto" && !capability.supportedProfiles.includes(value))) {
        throw new acp.RequestError(-32602, "当前 ModelStudent 不支持该思考强度");
      }
      const session = await this.sessions.setReasoningOverride(
        params.sessionId,
        value === "auto" ? undefined : value,
      );
      return { configOptions: reasoningConfigOptions(capability, session.reasoningOverride) };
    });
  }

  /** 执行「reasoningCapability」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
private reasoningCapability(session: SessionRecord): ModelReasoningCapability | undefined {
    const selected = this.models?.get(session.modelStudentId);
    return selected?.supports.reasoning;
  }

  /** 为 Session 创建唯一活动 Turn、固定运行作用域，并在所有终态清理 channel/projection/AbortController。 */
private async prompt(
    params: acp.PromptRequest,
    client: acp.AgentContext,
    requestSignal: AbortSignal,
  ): Promise<acp.PromptResponse> {
    if (this.active.has(params.sessionId) || this.pendingPrompts.has(params.sessionId)) {
      throw new acp.RequestError(-32000, "这个会话已有一轮回答正在生成");
    }
    const text = promptText(params.prompt);
    if (!text) throw new Error("初版只接受非空文本消息");

    const controller = new AbortController();
    this.pendingPrompts.set(params.sessionId, controller);
    const promptMeta = readPromptMeta(params._meta);
    const turnId = promptMeta?.turnId ?? randomUUID();
    let session: SessionRecord;
    let artifactMentions: ArtifactMention[] = [];
    try {
      const reserved = await this.serializeSessionState(params.sessionId, /** 执行「reserved」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async () => {
        if (this.active.has(params.sessionId)) {
          throw new acp.RequestError(-32000, "这个会话已有一轮回答正在生成");
        }
        const current = await this.sessions.getRecent(
          params.sessionId,
          PRODUCT_CONFIG.agent.historyRecentTurnsMax,
        );
        if (current.ownerId !== this.principalId) throw new Error("Session 不存在");
        if (this.models && !this.models.isReady(current.modelStudentId, this.principalId)) {
          throw new acp.RequestError(
            -32002,
            "该会话绑定的模型已停用、删除或当前不可用，不能继续对话",
            { code: "SESSION_MODEL_UNAVAILABLE", retryable: false },
          );
        }
        if (current.purpose === "chat" && !await this.bindings.agentExists(current.agentId)) {
          throw new acp.RequestError(
            -32002,
            "该会话绑定的 Agent 已删除，不能继续对话",
            { code: "SESSION_AGENT_DELETED", retryable: false },
          );
        }
        const requestedIds = promptMeta?.artifactMentions?.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.artifactId) ?? [];
        if (requestedIds.length > 0 && !this.artifacts) {
          throw new acp.RequestError(-32602, "当前 Remote 不支持 Artifact Mention");
        }
        const mentions = this.artifacts
          ? await this.artifacts.resolveMentions(requestedIds, current.ownerId)
          : [];
        this.active.set(current.id, controller);
        this.pendingPrompts.delete(params.sessionId);
        return { session: current, mentions };
      });
      session = reserved.session;
      artifactMentions = reserved.mentions;
    } catch (error) {
      this.pendingPrompts.delete(params.sessionId);
      throw error;
    }

    const channel = new SessionAcpChannel(client, session.id);
    const detachClient = /** 执行「detachClient」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => channel.detach(client);
    if (requestSignal.aborted) detachClient();
    else requestSignal.addEventListener("abort", detachClient, { once: true });
    this.channels.set(session.id, channel);
    const output = new AcpOutput(session.id, channel);

    const user = makeMessage("user", text, turnId, randomUUID(), artifactMentions);
    const projection = new TurnProjection(
      session.id,
      turnId,
      user,
      output,
      channel,
      this.sessions,
      controller.signal,
      Boolean(session.experimentRef),
    );
    this.projections.set(session.id, projection);
    let failure: unknown = null;
    let reason: acp.StopReason = "end_turn";
    let turnStarted = false;
    try {
      const started = await this.sessions.startTurnWithPrompt(session.id, turnId, user, {
        modelStudentId: session.modelStudentId,
        agentId: session.agentId,
      });
      turnStarted = true;
      await output.turnState(started.state);
      await output.message("user", user.messageId, text, {
        schemaVersion: 1,
        turnId,
        chunkIndex: 0,
        final: true,
        ...(artifactMentions.length > 0 ? { artifactMentions } : {}),
      });
      if (session.experimentRef && this.experiments) {
        await this.experiments.markRunStarted(session.experimentRef.experimentId, session.experimentRef.variantId, session.id, turnId);
      }
    } catch (error) {
      if (turnStarted) {
        await this.sessions.transitionTurn(session.id, turnId, "finalizing").catch(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => undefined);
        await this.sessions.finishTurn(session.id, turnId, "failed", {
          entryIds: [entryIdentity(user)],
          error: { code: "TURN_START_FAILED", message: "该 Turn 启动失败", retryable: true },
        }).catch(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => undefined);
      }
      requestSignal.removeEventListener("abort", detachClient);
      channel.close();
      this.channels.delete(session.id);
      this.projections.delete(session.id);
      this.active.delete(session.id);
      throw error;
    }

    let runtimeHistory: SessionEntry[] = session.sessionEntries;
    try {
      runtimeHistory = session.experimentRef && this.experiments
        ? await this.experiments.runtimeHistory(session.experimentRef.experimentId, session.ownerId)
        : session.sessionEntries;
      const result = await this.runtime.run(
        {
          text: promptWithArtifacts(text, artifactMentions),
          sessionEntries: runtimeHistory,
          sessionId: session.id,
          turnId,
          scope: turnScope(session, turnId, promptMeta?.operationId),
        },
        projection,
        controller.signal,
      );
      await projection.usage(result.usage);
      if (result.reason === "cancelled") reason = "cancelled";
      else if (result.reason === "length") reason = "max_tokens";
    } catch (error) {
      failure = error;
    } finally {
      try {
        try {
          await projection.finalizeOpenRounds();
        } catch (error) {
          failure ??= error;
        }
        const contextWindow = await this.contextWindowState(
          session,
          turnId,
          [...runtimeHistory, user, ...projection.entriesSnapshot()],
        );
        try {
          await projection.contextWindowUsage(contextWindow);
        } catch (error) {
          // 该快照是派生展示事实；通知失败不能篡改已完成的模型或 Tool 结果。
          console.error("上下文窗口快照投影失败", error);
        }
        await projection.phase("finalizing");
        const terminalStatus = controller.signal.aborted || reason === "cancelled" ? "cancelled" : failure ? "failed" : "completed";
        const completed = await this.sessions.finishTurnWithEntries(
          session.id,
          turnId,
          terminalStatus,
          projection.streamingSessionEntries,
          {
            ...projection.executionFacts(),
            entryIds: [entryIdentity(user), ...projection.streamingSessionEntries.map(entryIdentity)],
            stopReason: reason,
            ...(failure ? { error: turnFailureFacts(failure) } : {}),
          },
        );
        await output.turnState(completed.state);
        if (session.experimentRef && this.experiments) {
          try {
            await this.experiments.markRunFinished(
              session.experimentRef.experimentId,
              session.experimentRef.variantId,
              session.id,
              turnId,
              terminalStatus,
              projection.streamingSessionEntries.flatMap(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(entry) => entry.type === "message" && entry.role === "assistant" ? [entry.text] : []),
              failure,
            );
          } catch (experimentError) {
            // 实验索引是 Turn 终态之后的派生记录，失败不能篡改已经提交的 Turn 事实。
            console.error("Experiment lane 终态索引失败", experimentError);
          }
        }
      } catch (finalizationError) {
        console.error("Prompt Turn 终态保存失败", finalizationError);
        failure ??= finalizationError;
      } finally {
        requestSignal.removeEventListener("abort", detachClient);
        channel.close();
        if (this.channels.get(session.id) === channel) this.channels.delete(session.id);
        if (this.projections.get(session.id) === projection) this.projections.delete(session.id);
        this.active.delete(session.id);
      }
    }

    if (failure instanceof RunFailure) {
      // 详细 cause 只写 Remote 日志；ACP 仅承载 Turn 失败的可读原因。
      console.error("Prompt Turn 执行失败", failure.cause ?? failure);
      throw new acp.RequestError(-32001, failure.message);
    }
    if (failure) throw failure;
    return { stopReason: reason };
  }

  /** 判断「cancel」对应条件，只返回判定结果且不修改输入状态。 */
private cancel(sessionId: string): void {
    this.pendingPrompts.get(sessionId)?.abort();
    this.active.get(sessionId)?.abort();
  }

  private async cancelOwned(sessionId: string): Promise<void> {
    await this.requireOwnedSession(sessionId, 0);
    this.cancel(sessionId);
  }

  /** 执行「contextWindowState」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
private async contextWindowState(
    session: SessionRecord,
    turnId: string,
    sessionEntries: SessionEntry[],
  ): Promise<ContextWindowUsageState> {
    try {
      const preview = await this.runtime.previewContextWindow(
        {
          sessionEntries,
          scope: turnScope(session, turnId),
        },
        AbortSignal.timeout(10_000),
      );
      return preview
        ? {
            schemaVersion: 1,
            status: "available",
            afterTurnId: turnId,
            ...preview,
          }
        : {
            schemaVersion: 1,
            status: "unavailable",
            afterTurnId: turnId,
            reason: "unknown_window",
          };
    } catch (error) {
      console.error("生成上下文窗口快照失败", error);
      return {
        schemaVersion: 1,
        status: "unavailable",
        afterTurnId: turnId,
        reason: "preview_failed",
      };
    }
  }

  /**
   * ACP Handler 是异步的，同一连接上的调用也可能交错。
   * 这里只串行化“预占 Turn”或“修改 Session 配置”的短状态转换；不同 Session 的模型运行仍可并发。
   */
  /** 按 Session 串行执行 load/resume 状态操作，settle 后删除 Promise 链防止跨会话增长。 */
private async serializeSessionState<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionStateOperations.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => undefined).then(operation);
    this.sessionStateOperations.set(sessionId, current);
    try {
      return await current;
    } finally {
      if (this.sessionStateOperations.get(sessionId) === current) {
        this.sessionStateOperations.delete(sessionId);
      }
    }
  }

  /** 校验并取得「requireSession」所需对象；缺失或归属不符时立即抛出明确错误。 */
private async requireSession(id: string, cwd: string, maxTurns?: number): Promise<SessionRecord> {
    const session = maxTurns === undefined ? await this.sessions.get(id) : await this.sessions.getRecent(id, maxTurns);
    if (session.ownerId !== this.principalId) throw new Error("Session 不存在");
    if (session.cwd !== cwd) throw new Error("会话 cwd 与请求不一致");
    return session;
  }

  private async requireOwnedSession(id: string, maxTurns?: number): Promise<SessionRecord> {
    const session = maxTurns === undefined ? await this.sessions.get(id) : await this.sessions.getRecent(id, maxTurns);
    if (session.ownerId !== this.principalId) throw new Error("Session 不存在");
    return session;
  }
}

class TurnProjection implements RunObserver {
  readonly streamingSessionEntries: SessionEntry[] = [];
  private readonly messages = new Map<number, SessionMessageEntry>();
  private readonly thoughts = new Map<number, SessionThoughtEntry>();
  private readonly messageChunks = new Map<number, number>();
  private readonly thoughtChunks = new Map<number, number>();
  private readonly modelItems = new Map<string, {
    round: number;
    kind: ModelOutputItemStarted["kind"];
    callId?: string;
    completed: boolean;
  }>();
  private readonly attempts = new Map<number, RuntimeModelAttemptSnapshot>();
  private runtimeFacts: RuntimeTurnSnapshot | undefined;
  private readonly capabilityFacts: NonNullable<import("../repository/session-types.js").TurnExecutionRecord["capabilitySnapshots"]> = [];
  private readonly roundFacts: NonNullable<import("../repository/session-types.js").TurnExecutionRecord["modelRounds"]> = [];
  private usageFacts: TurnTokenUsage | undefined;
  private executionSequence = 0;
  private activeRound = 0;
  private readonly toolRounds = new Map<string, number>();

  /** 初始化「TurnProjection」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(
    private readonly sessionId: string,
    private readonly turnId: string,
    private readonly promptEntry: SessionMessageEntry,
    private readonly output: AcpOutput,
    private readonly channel: SessionAcpChannel,
    private readonly sessions: SessionRepository,
    private readonly signal: AbortSignal,
    private readonly streamExecution: boolean,
  ) {}

  /** 判断「matchesTurn」对应条件，只返回判定结果且不修改输入状态。 */
matchesTurn(turnId: string): boolean { return this.turnId === turnId; }

  /** 生成「entriesSnapshot」不可变视图，隔离后续状态修改并只暴露该层需要的事实。 */
entriesSnapshot(): SessionEntry[] { return structuredClone(this.streamingSessionEntries); }

  /** 执行「context」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async context(summary: ContextSummary): Promise<void> {
    const entry: SessionContextSummaryEntry = {
      type: "context_summary",
      turnId: this.turnId,
      summary: structuredClone(summary),
      createdAt: new Date().toISOString(),
    };
    this.streamingSessionEntries.push(entry);
    await this.sessions.checkpointTurnEntries(this.sessionId, this.turnId, [entry]);
    await this.output.contextSummary(summary);
  }

  /** 执行「phase」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async phase(phase: TurnActivePhase): Promise<void> {
    console.warn("[turn-phase] request", JSON.stringify({ sessionId: this.sessionId, turnId: this.turnId, phase }));
    const turn = await this.sessions.transitionTurn(this.sessionId, this.turnId, phase);
    console.warn("[turn-phase] persisted", JSON.stringify({
      sessionId: this.sessionId,
      turnId: this.turnId,
      state: turnStateLogFacts(turn.state),
    }));
    await this.output.turnState(turn.state);
  }

  /** 生成「turnSnapshot」不可变视图，隔离后续状态修改并只暴露该层需要的事实。 */
async turnSnapshot(facts: RuntimeTurnSnapshot): Promise<void> {
    this.runtimeFacts = structuredClone(facts);
    await this.sessions.checkpointTurn(this.sessionId, this.turnId, runtimeTurnFacts(facts));
  }

  /** 生成「capabilitySnapshot」不可变视图，隔离后续状态修改并只暴露该层需要的事实。 */
async capabilitySnapshot(generation: number, hash: string, snapshot: RuntimeCapabilitySnapshot): Promise<void> {
    if (this.capabilityFacts.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.generation === generation)) return;
    this.capabilityFacts.push({ generation, hash, snapshot: structuredClone(snapshot) });
    await this.sessions.checkpointTurn(this.sessionId, this.turnId, {
      capabilitySnapshots: structuredClone(this.capabilityFacts),
    });
  }

  /** 执行「modelRoundStarted」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
  async modelRoundStarted(facts: RuntimeModelRoundSnapshot): Promise<void> {
    this.activeRound = facts.roundIndex;
    await this.executionEvent({
      type: "model_round_started",
      roundIndex: facts.roundIndex,
      startedAt: Date.parse(facts.startedAt),
    });
    this.roundFacts.push(structuredClone(facts));
    const persisted = await this.sessions.checkpointTurn(this.sessionId, this.turnId, {
      modelRounds: structuredClone(this.roundFacts),
    });
    // Repository 已把完整 Provider Input 转移到 evidence sidecar；投影内存也立即改持轻量引用。
    this.roundFacts.splice(0, this.roundFacts.length, ...structuredClone(persisted.modelRounds ?? []));
  }

  /** 新 Attempt 复用稳定 messageId，但先整体清空上一 Attempt 的正文与思考投影。 */
  async modelAttemptStarted(round: number, facts: RuntimeModelAttemptSnapshot): Promise<void> {
    const previous = this.attempts.get(round);
    this.attempts.set(round, structuredClone(facts));
    await this.executionEvent({
      type: "model_attempt_started",
      roundIndex: round,
      attemptId: facts.attemptId,
      attemptIndex: facts.attemptIndex,
      maxAttempts: facts.maxAttempts,
      startedAt: Date.parse(facts.startedAt),
    });
    if (!previous) return;

    for (const [itemId, item] of this.modelItems) {
      if (item.round === round) this.modelItems.delete(itemId);
    }

    const message = this.messages.get(round);
    if (message) {
      message.text = "";
      message.modelAttemptId = facts.attemptId;
      message.modelAttemptIndex = facts.attemptIndex;
      this.messageChunks.set(round, 0);
      await this.output.message("assistant", message.messageId, "", {
        schemaVersion: 1,
        turnId: this.turnId,
        chunkIndex: 0,
        modelAttempt: { id: facts.attemptId, index: facts.attemptIndex, reset: true },
      });
    }
    const thought = this.thoughts.get(round);
    if (thought) {
      thought.text = "";
      thought.modelAttemptId = facts.attemptId;
      thought.modelAttemptIndex = facts.attemptIndex;
      this.thoughtChunks.set(round, 0);
      await this.output.thought(thought.messageId, "", {
        schemaVersion: 1,
        turnId: this.turnId,
        chunkIndex: 0,
        modelAttempt: { id: facts.attemptId, index: facts.attemptIndex, reset: true },
      });
    }
  }

  /** 把模型失败事实实时投影给实验页；失败正文仍由 Attempt reset 机制整体替换。 */
  async modelAttemptFailed(round: number, facts: RuntimeModelAttemptFailureSnapshot): Promise<void> {
    await this.executionEvent({
      type: "model_attempt_failed",
      roundIndex: round,
      attemptId: facts.attemptId,
      attemptIndex: facts.attemptIndex,
      completedAt: Date.parse(facts.completedAt),
      error: facts.error,
      ...(facts.retryDelayMs === undefined ? {} : { retryDelayMs: facts.retryDelayMs }),
    });
  }

  /** 把模型成功事实实时投影给实验页。 */
  async modelAttemptCompleted(round: number, facts: RuntimeModelAttemptCompletionSnapshot): Promise<void> {
    await this.executionEvent({
      type: "model_attempt_completed",
      roundIndex: round,
      attemptId: facts.attemptId,
      attemptIndex: facts.attemptIndex,
      completedAt: Date.parse(facts.completedAt),
    });
  }

  /** 执行「modelRoundCompleted」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async modelRoundCompleted(round: number, completedAt: string): Promise<void> {
    const current = this.roundFacts.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.roundIndex === round);
    if (!current) return;
    current.completedAt = completedAt;
    const persisted = await this.sessions.checkpointTurn(this.sessionId, this.turnId, {
      modelRounds: structuredClone(this.roundFacts),
    });
    this.roundFacts.splice(0, this.roundFacts.length, ...structuredClone(persisted.modelRounds ?? []));
  }

  /** 执行「usage」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async usage(modelUsage: TurnModelUsage): Promise<void> {
    const usage: TurnTokenUsage = {
      schemaVersion: 1,
      turnId: this.turnId,
      modelRequests: modelUsage.modelRequests,
      components: tokenComponents([this.promptEntry, ...this.streamingSessionEntries]),
      ...(modelUsage.inputTokens !== undefined
        ? { inputTokens: modelUsage.inputTokens }
        : {}),
      ...(modelUsage.outputTokens !== undefined
        ? { outputTokens: modelUsage.outputTokens }
        : {}),
      ...(modelUsage.cachedInputTokens !== undefined
        ? { cachedInputTokens: modelUsage.cachedInputTokens }
        : {}),
      ...(modelUsage.reasoningOutputTokens !== undefined
        ? { reasoningOutputTokens: modelUsage.reasoningOutputTokens }
        : {}),
    };
    const entry: SessionTokenUsageEntry = {
      type: "token_usage",
      turnId: this.turnId,
      usage: structuredClone(usage),
      createdAt: new Date().toISOString(),
    };
    this.usageFacts = structuredClone(usage);
    this.streamingSessionEntries.push(entry);
    await this.sessions.checkpointTurnEntries(this.sessionId, this.turnId, [entry]);
    await this.output.tokenUsage(usage);
  }

  /** 执行「contextWindowUsage」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async contextWindowUsage(state: ContextWindowUsageState): Promise<void> {
    const entry: SessionContextWindowUsageEntry = {
      type: "context_window_usage",
      turnId: this.turnId,
      state: structuredClone(state),
      createdAt: new Date().toISOString(),
    };
    this.streamingSessionEntries.push(entry);
    await this.output.contextWindowUsage(state);
  }

  /** 生成「executionFacts」不可变视图，隔离后续状态修改并只暴露该层需要的事实。 */
executionFacts(): Partial<import("../repository/session-types.js").TurnExecutionRecord> {
    return {
      ...(this.runtimeFacts ? runtimeTurnFacts(this.runtimeFacts) : {}),
      capabilitySnapshots: structuredClone(this.capabilityFacts),
      modelRounds: structuredClone(this.roundFacts),
      ...(this.usageFacts ? { usage: structuredClone(this.usageFacts) } : {}),
    };
  }

  /** 记录模型 item 的显式开始；工具请求一旦可稳定关联就立即投影为 pending。 */
async modelOutputItemStarted(round: number, item: ModelOutputItemStarted): Promise<void> {
    if (this.modelItems.has(item.id)) throw new Error(`模型输出 item 重复开始: ${item.id}`);
    this.modelItems.set(item.id, {
      round,
      kind: item.kind,
      ...(item.kind === "tool_call" ? { callId: item.callId } : {}),
      completed: false,
    });
    if (item.kind !== "tool_call") return;

    const existing = this.streamingSessionEntries.find(
      (entry): entry is SessionToolCallEntry => entry.type === "tool_call" && entry.toolCallId === item.callId,
    );
    const entry: SessionToolCallEntry = existing ?? {
      type: "tool_call",
      turnId: this.turnId,
      toolCallId: item.callId,
      title: "准备工具调用",
      name: "tool",
      kind: "other",
      status: "pending",
      rawInput: {},
      content: [],
      locations: [],
      createdAt: new Date().toISOString(),
    };
    entry.title = item.name ? `准备 ${item.name}` : "准备工具调用";
    entry.name = item.name ?? "tool";
    entry.kind = "other";
    entry.status = "pending";
    entry.rawInput = {};
    delete entry.rawOutput;
    delete entry.modelContent;
    delete entry.outcomeStatus;
    entry.content = [];
    entry.locations = [];
    this.toolRounds.set(item.callId, round);
    if (!existing) this.streamingSessionEntries.push(entry);
    await this.sessions.checkpointTurnEntries(this.sessionId, this.turnId, [entry]);
    await this.output.toolCall({
      toolCallId: item.callId,
      title: entry.title,
      name: entry.name,
      kind: entry.kind,
      status: "pending",
      rawInput: {},
      locations: [],
    });
  }

  /** 文本增量沿用 ACP chunk；工具参数只在 Remote 聚合，避免把大参数逐片复制到 Browser。 */
async modelOutputItemDelta(round: number, itemId: string, delta: ModelOutputItemDelta): Promise<void> {
    const state = this.modelItems.get(itemId);
    if (!state || state.round !== round || state.completed) throw new Error(`模型输出 item 增量无有效活动项: ${itemId}`);
    if (state.kind === "message") {
      if (delta.kind !== "text") throw new Error(`消息 item 收到非文本增量: ${itemId}`);
      await this.appendMessage(round, delta.text);
    } else if (state.kind === "reasoning") {
      if (delta.kind !== "text") throw new Error(`思考 item 收到非文本增量: ${itemId}`);
      await this.appendThought(round, delta.text);
    }
  }

  /** item 完成时立刻关闭对应消息，而不是等待整个模型 Round 结束。 */
async modelOutputItemCompleted(round: number, item: ModelOutputItemCompleted): Promise<void> {
    const state = this.modelItems.get(item.id);
    if (!state || state.round !== round || state.kind !== item.kind || state.completed) {
      throw new Error(`模型输出 item 完成边界无效: ${item.id}`);
    }
    state.completed = true;
    if (item.kind === "message") await this.finalizeMessage(round);
    else if (item.kind === "reasoning") await this.finalizeThought(round);
  }

  /** Provider/Attempt 异常时关闭活动文本并把尚未执行的工具请求置为失败。 */
async modelOutputItemsAborted(round: number, _reason: "failed" | "cancelled"): Promise<void> {
    for (const state of this.modelItems.values()) {
      if (state.round !== round || state.completed) continue;
      state.completed = true;
      if (state.kind === "message") await this.finalizeMessage(round);
      else if (state.kind === "reasoning") await this.finalizeThought(round);
    }
    for (const entry of this.streamingSessionEntries) {
      if (entry.type !== "tool_call" || this.toolRounds.get(entry.toolCallId) !== round) continue;
      if (entry.status !== "pending") continue;
      entry.status = "failed";
      await this.sessions.checkpointTurnEntries(this.sessionId, this.turnId, [entry]);
      await this.output.toolUpdate({ toolCallId: entry.toolCallId, status: "failed" });
    }
  }

  /** 执行「providerContinuation」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async providerContinuation(
    round: number,
    continuation: ProviderOpaqueContinuation,
    calls: import("../model/model-provider.js").ModelToolCall[],
  ): Promise<void> {
    const visibleEntryIds = [this.messages.get(round), this.thoughts.get(round)]
      .flatMap(/** 执行「visibleEntryIds」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(entry) => entry ? [entry.messageId] : []);
    this.streamingSessionEntries.push({
      type: "provider_continuation",
      turnId: this.turnId,
      roundIndex: round,
      continuation: withProviderContinuationCorrelation(continuation, {
        messageIds: visibleEntryIds,
        toolCallIds: calls.flatMap(/** 根据已校验输入构建「toolCallIds」结果，不额外持有调用方的大对象。 */
(call) => call.id ? [call.id] : []),
      }),
      createdAt: new Date().toISOString(),
    });
  }

  /** 执行「finalizeOpenRounds」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async finalizeOpenRounds(): Promise<void> {
    const open = [...this.modelItems.values()].filter((item) => !item.completed);
    for (const round of new Set(open.map((item) => item.round))) {
      await this.modelOutputItemsAborted(round, this.signal.aborted ? "cancelled" : "failed");
    }
    for (const entry of this.streamingSessionEntries) {
      if (entry.type !== "tool_call" || entry.status !== "pending") continue;
      entry.status = "failed";
      await this.sessions.checkpointTurnEntries(this.sessionId, this.turnId, [entry]);
      await this.output.toolUpdate({ toolCallId: entry.toolCallId, status: "failed" });
    }
  }

  /** 工具请求已经生成并通过 Registry 规范化，但仍未进入真实 Handler。 */
  async toolPrepared(call: PreparedToolCall): Promise<void> {
    const entry = this.findToolEntry(call.id);
    entry.title = call.title;
    entry.name = call.name;
    entry.kind = call.kind;
    entry.rawInput = call.arguments;
    entry.locations = call.locations;
    await this.sessions.checkpointTurnEntries(this.sessionId, this.turnId, [entry]);
    await this.output.toolUpdate({
      toolCallId: call.id,
      title: call.title,
      name: call.name,
      kind: call.kind,
      status: "pending",
      rawInput: call.arguments,
      locations: call.locations,
    });
  }

  /** 只有即将调用 Registry Handler 时才进入 in_progress 并记录执行起点。 */
  async toolExecutionStarted(call: PreparedToolCall): Promise<void> {
    console.warn("[tool] start", JSON.stringify({ sessionId: this.sessionId, turnId: this.turnId, toolCallId: call.id, name: call.name, permission: call.permission }));
    const startedAt = Date.now();
    this.toolRounds.set(call.id, this.activeRound);
    await this.executionEvent({
      type: "tool_call_started",
      roundIndex: this.activeRound,
      toolCallId: call.id,
      name: call.name,
      title: call.title,
      startedAt,
    });
    const entry = this.findToolEntry(call.id);
    entry.status = "in_progress";
    await this.sessions.checkpointTurnEntries(this.sessionId, this.turnId, [entry]);
    await this.output.toolUpdate({
      toolCallId: call.id,
      status: "in_progress",
    });
  }

  /** 根据已校验输入构建「toolFinish」结果，不额外持有调用方的大对象。 */
  async toolFinish(
    call: PreparedToolCall,
    status: acp.ToolCallStatus,
    result: ToolOutcome,
  ): Promise<void> {
    console.warn("[tool] finish", JSON.stringify({ sessionId: this.sessionId, turnId: this.turnId, toolCallId: call.id, name: call.name, status, outcomeStatus: result.status }));
    await this.executionEvent({
      type: "tool_call_completed",
      roundIndex: this.toolRounds.get(call.id) ?? this.activeRound,
      toolCallId: call.id,
      completedAt: Date.now(),
      status: result.status,
      ...(result.error ? { error: { code: result.error.code, message: result.error.message } } : {}),
    });
    const entry = this.findToolEntry(call.id);
    const content = "content" in result ? result.content : [];
    const locations = "locations" in result ? result.locations : call.locations;
    entry.status = status;
    entry.rawOutput = result.rawOutput;
    entry.modelContent = result.modelContent;
    entry.outcomeStatus = result.status;
    entry.content = content;
    entry.locations = locations;
    await this.sessions.checkpointTurnEntries(this.sessionId, this.turnId, [entry]);
    await this.output.toolUpdate({
      toolCallId: call.id,
      status,
      rawOutput: result.rawOutput,
      content,
      locations,
    });
  }

  /** 实验专用的临时投影不写 Session；sequence 只用于同一 Turn 内去重和保序。 */
  private async executionEvent(data: LiveExecutionEventData): Promise<void> {
    if (!this.streamExecution) return;
    const event: LiveExecutionEvent = {
      schemaVersion: 1,
      turnId: this.turnId,
      sequence: this.executionSequence,
      ...data,
    };
    this.executionSequence += 1;
    await this.output.executionTrace(event);
  }

  /** 执行「requestPermission」主流程，传播取消与失败并在结束时清理临时资源。 */
async requestPermission(call: PreparedToolCall): Promise<boolean> {
    const interaction: TurnPendingPermissionInteraction = {
      schemaVersion: 1,
      interactionId: makeTurnInteractionId("permission", call.id),
      kind: "permission",
      toolCall: {
        toolCallId: call.id,
        title: call.title,
        name: call.name,
        kind: call.kind,
        rawInput: structuredClone(call.arguments),
        locations: call.locations.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(location) => ({
          path: location.path,
          ...(location.line === null || location.line === undefined ? {} : { line: location.line }),
        })),
      },
      options: [
        { optionId: "allow-once", name: "允许本次执行", kind: "allow_once" },
        { optionId: "reject-once", name: "拒绝本次执行", kind: "reject_once" },
      ],
      requestedAt: new Date().toISOString(),
    };
    await this.beginInteraction(interaction);
    console.warn("[permission] requested", JSON.stringify({
      sessionId: this.sessionId,
      turnId: this.turnId,
      toolCallId: call.id,
      name: call.name,
      interactionId: interaction.interactionId,
      requestedAt: interaction.requestedAt,
    }));
    try {
      const response = await this.channel.request<acp.RequestPermissionResponse>(interaction.interactionId, this.signal, /** 执行「response」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(client) => client.request(
        acp.methods.client.session.requestPermission, {
          sessionId: this.sessionId,
          toolCall: {
            ...interaction.toolCall,
            status: "pending",
          },
          options: interaction.options,
        }),
      );
      const allowed = (
        response.outcome.outcome === "selected" &&
        response.outcome.optionId === "allow-once"
      );
      console.warn("[permission] resolved", JSON.stringify({
        sessionId: this.sessionId,
        turnId: this.turnId,
        toolCallId: call.id,
        interactionId: interaction.interactionId,
        outcome: response.outcome,
        allowed,
      }));
      return allowed;
    } finally {
      await this.finishInteraction(interaction.interactionId);
    }
  }

  /** 执行「askUser」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async askUser(question: string, toolCallId: string): Promise<string> {
    const interaction: TurnPendingElicitationInteraction = {
      schemaVersion: 1,
      interactionId: makeTurnInteractionId("elicitation", toolCallId),
      kind: "elicitation",
      toolCallId,
      message: question,
      requestedSchema: {
        type: "object",
        properties: {
          answer: {
            type: "string",
            title: "你的回答",
            minLength: 1,
            maxLength: 4000,
          },
        },
        required: ["answer"],
      },
      requestedAt: new Date().toISOString(),
    };
    await this.beginInteraction(interaction);
    try {
      const response = await this.channel.request<acp.CreateElicitationResponse>(interaction.interactionId, this.signal, /** 执行「response」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(client) => client.request(
        acp.methods.client.elicitation.create, {
          sessionId: this.sessionId,
          toolCallId: interaction.toolCallId,
          mode: "form",
          message: interaction.message,
          requestedSchema: interaction.requestedSchema,
        }),
      );
      if (response.action !== "accept") {
        // AskUser 的取消语义是停止当前 Turn，不应伪装成一次 Tool 执行失败。
        throw new DOMException("用户取消了回答", "AbortError");
      }
      const answer = isRecord(response.content) ? response.content.answer : undefined;
      if (typeof answer !== "string" || answer.trim().length === 0) {
        throw new Error("用户没有提供有效回答");
      }
      return answer;
    } finally {
      await this.finishInteraction(interaction.interactionId);
    }
  }

  /** 执行「beginInteraction」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
private async beginInteraction(interaction: TurnPendingInteraction): Promise<void> {
    const turn = await this.sessions.addTurnInteraction(this.sessionId, this.turnId, interaction);
    console.warn("[turn-interaction] persisted", JSON.stringify({
      sessionId: this.sessionId,
      turnId: this.turnId,
      interactionId: interaction.interactionId,
      kind: interaction.kind,
      waitingFor: turn.state.status === "active" ? turn.state.waitingFor : undefined,
    }));
    await this.output.turnState(turn.state);
  }

  /** 执行「finishInteraction」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
private async finishInteraction(interactionId: string): Promise<void> {
    const turn = await this.sessions.removeTurnInteraction(this.sessionId, this.turnId, interactionId);
    console.warn("[turn-interaction] resolved", JSON.stringify({
      sessionId: this.sessionId,
      turnId: this.turnId,
      interactionId,
      waitingFor: turn.state.status === "active" ? turn.state.waitingFor : undefined,
    }));
    await this.output.turnState(turn.state);
  }

  /** 追加 assistant 正文 chunk；messageId 仍按 round 稳定，保证 Attempt reset 兼容。 */
private async appendMessage(round: number, value: string): Promise<void> {
    const entry = this.ensureMessage(round);
    entry.text += value;
    const index = this.messageChunks.get(round) ?? 0;
    this.messageChunks.set(round, index + 1);
    await this.output.message("assistant", entry.messageId, value, {
      schemaVersion: 1,
      turnId: this.turnId,
      chunkIndex: index,
      ...attemptMessageMeta(this.attempts.get(round)),
    });
  }

  /** 追加 reasoning chunk；终态只由显式 item completed/aborted 产生。 */
private async appendThought(round: number, value: string): Promise<void> {
    const entry = this.ensureThought(round);
    entry.text += value;
    const index = this.thoughtChunks.get(round) ?? 0;
    this.thoughtChunks.set(round, index + 1);
    await this.output.thought(entry.messageId, value, {
      schemaVersion: 1,
      turnId: this.turnId,
      chunkIndex: index,
      ...attemptMessageMeta(this.attempts.get(round)),
    });
  }

  /** 先 checkpoint 完整正文，再发送 ACP final 边界。 */
private async finalizeMessage(round: number): Promise<void> {
    const entry = this.messages.get(round);
    if (!entry) return;
    await this.sessions.checkpointTurnEntries(this.sessionId, this.turnId, [entry]);
    await this.output.message("assistant", entry.messageId, "", {
      schemaVersion: 1,
      turnId: this.turnId,
      chunkIndex: this.messageChunks.get(round) ?? 0,
      final: true,
      ...attemptMessageMeta(this.attempts.get(round)),
    });
  }

  /** 先 checkpoint 完整思考，再发送 ACP final 边界。 */
private async finalizeThought(round: number): Promise<void> {
    const entry = this.thoughts.get(round);
    if (!entry) return;
    await this.sessions.checkpointTurnEntries(this.sessionId, this.turnId, [entry]);
    await this.output.thought(entry.messageId, "", {
      schemaVersion: 1,
      turnId: this.turnId,
      chunkIndex: this.thoughtChunks.get(round) ?? 0,
      final: true,
      ...attemptMessageMeta(this.attempts.get(round)),
    });
  }

  /** 工具必须先由模型 item 创建 pending entry，后续阶段只能更新同一身份。 */
private findToolEntry(toolCallId: string): SessionToolCallEntry {
    const entry = this.streamingSessionEntries.find(
      (item): item is SessionToolCallEntry => item.type === "tool_call" && item.toolCallId === toolCallId,
    );
    if (!entry) throw new Error(`工具调用缺少 pending 投影: ${toolCallId}`);
    return entry;
  }

  /** 校验并取得「ensureMessage」所需对象；缺失或归属不符时立即抛出明确错误。 */
private ensureMessage(round: number): SessionMessageEntry {
    const existing = this.messages.get(round);
    if (existing) return existing;
    const entry = makeMessage("assistant", "", this.turnId, randomUUID());
    const attempt = this.attempts.get(round);
    if (attempt) {
      entry.modelAttemptId = attempt.attemptId;
      entry.modelAttemptIndex = attempt.attemptIndex;
    }
    this.messages.set(round, entry);
    this.streamingSessionEntries.push(entry);
    return entry;
  }

  /** 校验并取得「ensureThought」所需对象；缺失或归属不符时立即抛出明确错误。 */
private ensureThought(round: number): SessionThoughtEntry {
    const existing = this.thoughts.get(round);
    if (existing) return existing;
    const entry: SessionThoughtEntry = {
      type: "thought",
      text: "",
      turnId: this.turnId,
      messageId: randomUUID(),
      createdAt: new Date().toISOString(),
      ...sessionAttemptFields(this.attempts.get(round)),
    };
    this.thoughts.set(round, entry);
    this.streamingSessionEntries.push(entry);
    return entry;
  }
}

/** 把 Runtime Attempt 快照限制为 ACP 消息所需的最小代次信息。 */
function attemptMessageMeta(attempt: RuntimeModelAttemptSnapshot | undefined) {
  return attempt
    ? { modelAttempt: { id: attempt.attemptId, index: attempt.attemptIndex } }
    : {};
}

/** 把当前 Attempt 关联到活动 Session 投影，供断线增量回放识别代次。 */
function sessionAttemptFields(attempt: RuntimeModelAttemptSnapshot | undefined) {
  return attempt
    ? { modelAttemptId: attempt.attemptId, modelAttemptIndex: attempt.attemptIndex }
    : {};
}

/** 执行「runtimeTurnFacts」主流程，传播取消与失败并在结束时清理临时资源。 */
function runtimeTurnFacts(
  facts: RuntimeTurnSnapshot,
): Partial<import("../repository/session-types.js").TurnExecutionRecord> {
  return {
    modelStudentId: facts.modelStudentId,
    providerKind: facts.providerKind,
    model: facts.model,
    agentId: facts.agentId,
    agentSnapshotHash: facts.agentSnapshotHash,
    agentSnapshot: structuredClone(facts.agentSnapshot),
    resolvedReasoning: structuredClone(facts.resolvedReasoning),
  };
}

/** 生成「turnFailureFacts」不可变视图，隔离后续状态修改并只暴露该层需要的事实。 */
function turnFailureFacts(failure: unknown): { code: string; message: string; retryable: boolean } {
  return failure instanceof RunFailure
    ? { code: failure.code, message: failure.message, retryable: failure.retryable }
    : { code: "INTERNAL_ERROR", message: "该 Turn 执行失败", retryable: true };
}

/** 执行「replayEntry」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async function replayEntry(output: AcpOutput, entry: SessionEntry): Promise<void> {
  if (entry.type === "provider_continuation") return;
  if (entry.type === "message") {
    await output.message(entry.role, entry.messageId, entry.text, {
      schemaVersion: 1,
      turnId: entry.turnId,
      chunkIndex: 0,
      final: true,
      ...(entry.artifactMentions?.length ? { artifactMentions: entry.artifactMentions } : {}),
      ...entryAttemptMessageMeta(entry),
    });
  } else if (entry.type === "context_summary") {
    await output.contextSummary(entry.summary);
  } else if (entry.type === "token_usage") {
    await output.tokenUsage(entry.usage);
  } else if (entry.type === "context_window_usage") {
    await output.contextWindowUsage(entry.state);
  } else if (entry.type === "thought") {
    await output.thought(entry.messageId, entry.text, {
      schemaVersion: 1,
      turnId: entry.turnId,
      chunkIndex: 0,
      final: true,
      ...entryAttemptMessageMeta(entry),
    });
  } else {
    await output.toolCall({
      toolCallId: entry.toolCallId,
      title: entry.title,
      name: entry.name,
      kind: entry.kind,
      status: entry.status,
      rawInput: entry.rawInput,
      rawOutput: entry.rawOutput,
      content: entry.content,
      locations: entry.locations,
    });
  }
}

/** 生成「sessionEntriesWithActiveProjection」不可变视图，隔离后续状态修改并只暴露该层需要的事实。 */
function sessionEntriesWithActiveProjection(
  session: SessionRecord,
  projection: TurnProjection | undefined,
): SessionEntry[] {
  const entries = structuredClone(session.sessionEntries);
  if (!projection) return entries;
  const indexes = new Map(entries.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(entry, index) => [entryIdentity(entry), index]));
  for (const entry of projection.entriesSnapshot()) {
    const id = entryIdentity(entry);
    const index = indexes.get(id);
    if (index === undefined) {
      indexes.set(id, entries.length);
      entries.push(entry);
    } else {
      entries[index] = entry;
    }
  }
  return entries;
}

/** 执行「replayEntryDelta」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async function replayEntryDelta(
  output: AcpOutput,
  entry: SessionEntry,
  cursor: SessionResumeMeta,
  turnCompleted: boolean,
): Promise<void> {
  if (entry.type === "message") {
    const current = cursor.messages[entry.messageId];
    const attemptChanged = entry.modelAttemptId !== undefined && (
      current === undefined ||
      current.modelAttemptId !== undefined && current.modelAttemptId !== entry.modelAttemptId
    );
    const textLength = attemptChanged ? 0 : current?.textLength ?? 0;
    if (textLength > entry.text.length) throw new acp.RequestError(-32602, `消息恢复游标越界: ${entry.messageId}`);
    const text = entry.text.slice(textLength);
    const final = entry.role === "user" || turnCompleted;
    if (text.length === 0 && !attemptChanged) return;
    await output.message(entry.role, entry.messageId, text, {
      schemaVersion: 1,
      turnId: entry.turnId,
      chunkIndex: attemptChanged ? 0 : current?.nextChunkIndex ?? 0,
      ...(final ? { final: true } : {}),
      ...(entry.artifactMentions?.length ? { artifactMentions: entry.artifactMentions } : {}),
      ...entryAttemptMessageMeta(entry, attemptChanged),
    });
    return;
  }
  if (entry.type === "thought") {
    const current = cursor.thoughts[entry.messageId];
    const attemptChanged = entry.modelAttemptId !== undefined && (
      current === undefined ||
      current.modelAttemptId !== undefined && current.modelAttemptId !== entry.modelAttemptId
    );
    const textLength = attemptChanged ? 0 : current?.textLength ?? 0;
    if (textLength > entry.text.length) throw new acp.RequestError(-32602, `思考恢复游标越界: ${entry.messageId}`);
    const text = entry.text.slice(textLength);
    if (text.length === 0 && !attemptChanged) return;
    await output.thought(entry.messageId, text, {
      schemaVersion: 1,
      turnId: entry.turnId,
      chunkIndex: attemptChanged ? 0 : current?.nextChunkIndex ?? 0,
      ...(turnCompleted ? { final: true } : {}),
      ...entryAttemptMessageMeta(entry, attemptChanged),
    });
    return;
  }
  await replayEntry(output, entry);
}

/** 从活动 Session 条目恢复 Attempt 代次；reset 只用于浏览器仍持有上一代投影时。 */
function entryAttemptMessageMeta(
  entry: SessionMessageEntry | SessionThoughtEntry,
  reset = false,
) {
  return entry.modelAttemptId !== undefined && entry.modelAttemptIndex !== undefined
    ? {
        modelAttempt: {
          id: entry.modelAttemptId,
          index: entry.modelAttemptIndex,
          ...(reset ? { reset: true } : {}),
        },
      }
    : {};
}

/** 根据已校验输入构建「tokenComponents」结果，不额外持有调用方的大对象。 */
function tokenComponents(entries: SessionEntry[]): TokenUsageComponent[] {
  const components: TokenUsageComponent[] = [];
  for (const entry of entries) {
    if (entry.type === "message") {
      components.push({
        category: entry.role === "user" ? "current_prompt" : "answer",
        targetType: "message",
        targetId: entry.messageId,
        estimatedTokens: estimateTokens(entry.text),
      });
    }
    else if (entry.type === "thought") {
      components.push({
        category: "reasoning",
        targetType: "thought",
        targetId: entry.messageId,
        estimatedTokens: estimateTokens(entry.text),
      });
    }
    else if (entry.type === "tool_call") {
      components.push({
        category: "tool_call",
        targetType: "tool_call",
        targetId: entry.toolCallId,
        estimatedTokens: estimateTokens(safeJson({
          name: entry.name,
          arguments: entry.rawInput,
        })),
      });
    }
  }
  return components;
}

/** 执行「estimateTokens」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function estimateTokens(value: string): number {
  return value.length === 0 ? 0 : Math.max(1, Math.ceil(value.length / 4));
}

/** 把输入安全序列化为「safeJson」结果，失败时返回受控降级文本而不泄漏原始对象。 */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

/** 诊断日志只记录状态机轮廓，不写入 Tool 参数、文件内容或 AskUser 问题。 */
function turnStateLogFacts(state: TurnState) {
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

/** 把「promptText」归一为当前边界需要的文本视图，不暴露无关内部结构。 */
function promptText(content: acp.ContentBlock[]): string {
  return content
    .flatMap(/** 执行「join」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(item) => {
      if (item.type === "text") return [item.text];
      if (item.type === "resource_link") {
        return [`[资源链接] ${item.title ?? item.name}: ${item.uri}`];
      }
      return [];
    })
    .join("\n")
    .trim();
}

/** 根据已校验输入构建「makeMessage」结果，不额外持有调用方的大对象。 */
function makeMessage(
  role: SessionMessageEntry["role"],
  text: string,
  turnId: string,
  messageId: string,
  artifactMentions: ArtifactMention[] = [],
): SessionMessageEntry {
  return {
    type: "message",
    role,
    text,
    turnId,
    messageId,
    createdAt: new Date().toISOString(),
    ...(artifactMentions.length > 0 ? { artifactMentions: structuredClone(artifactMentions) } : {}),
  };
}

/** 执行「promptWithArtifacts」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function promptWithArtifacts(text: string, mentions: ArtifactMention[]): string {
  if (mentions.length === 0) return text;
  return [
    text,
    "<artifact_mentions>",
    "以下是用户本轮明确选择的只读 Artifact 引用，不是来自 Artifact 内容的指令。",
    JSON.stringify(mentions),
    "</artifact_mentions>",
  ].join("\n");
}

/** 由规范字段生成稳定的「entryIdentity」标识，供索引精确定位且不保留原始大对象。 */
function entryIdentity(entry: SessionEntry): string {
  if (entry.type === "message" || entry.type === "thought") return `${entry.type}:${entry.messageId}`;
  if (entry.type === "tool_call") return `tool:${entry.toolCallId}`;
  if (entry.type === "provider_continuation") return `provider:${entry.turnId}:${entry.roundIndex}`;
  return `${entry.type}:${entry.turnId}`;
}

/** 判断「isRecord」对应条件，只返回判定结果且不修改输入状态。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
