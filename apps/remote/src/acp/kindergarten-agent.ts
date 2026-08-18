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
} from "@kindergarten/contracts";
import { AcpOutput } from "./acp-output.js";
import type {
  AgentRuntime,
  RunObserver,
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
  SessionMessageEntry,
  SessionRecord,
  SessionTokenUsageEntry,
  SessionThoughtEntry,
  SessionToolCallEntry,
} from "../repository/session-types.js";
import type { PreparedToolCall, ToolOutcome } from "../tools/tool-registry.js";
import { RunFailure } from "../runtime/run-failure.js";
import type { SessionBindingService } from "../session/session-binding-service.js";
import { turnScope } from "../runtime/turn-scope.js";
import type { ExperimentService } from "../experiments/experiment-service.js";
import type { RuntimeCapabilitySnapshot } from "../capability/capability-types.js";
import type { ModelStudentCatalog } from "../model/model-student-catalog.js";
import { SessionAcpChannel } from "./session-acp-channel.js";
import type { ArtifactService } from "../artifacts/artifact-service.js";

const REASONING_CONFIG_ID = "reasoning_profile";

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
      ...capability.supportedProfiles.map((profile) => ({ value: profile, name: labels[profile] })),
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

  constructor(
    private readonly sessions: SessionRepository,
    private readonly runtime: AgentRuntime,
    private readonly bindings: SessionBindingService,
    private readonly experiments?: ExperimentService,
    private readonly models?: ModelStudentCatalog,
    private readonly artifacts?: ArtifactService,
  ) {}

  createApp(): acp.AgentApp {
    return acp
      .agent({ name: "model-kindergarten-remote" })
      .onRequest(acp.methods.agent.initialize, ({ params }) => this.initialize(params))
      .onRequest(acp.methods.agent.session.new, ({ params }) => this.newSession(params))
      .onRequest(acp.methods.agent.session.list, ({ params }) => this.listSessions(params))
      .onRequest(acp.methods.agent.session.load, ({ params, client }) =>
        this.loadSession(params, client),
      )
      .onRequest(acp.methods.agent.session.resume, ({ params, client }) =>
        this.resumeSession(params, client),
      )
      .onRequest(acp.methods.agent.session.close, ({ params }) =>
        this.closeSession(params),
      )
      .onRequest(acp.methods.agent.session.setConfigOption, ({ params }) =>
        this.setSessionConfigOption(params),
      )
      .onRequest(acp.methods.agent.session.prompt, ({ params, client, signal }) =>
        this.prompt(params, client, signal),
      )
      .onNotification(acp.methods.agent.session.cancel, ({ params }) =>
        this.cancel(params.sessionId),
      );
  }

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

  private async listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
    return { sessions: await this.sessions.list(params.cwd) };
  }

  private async loadSession(
    params: acp.LoadSessionRequest,
    client: acp.AgentContext,
  ): Promise<acp.LoadSessionResponse> {
    const session = await this.requireSession(params.sessionId, params.cwd);
    const activeChannel = this.channels.get(session.id);
    activeChannel?.beginResume();
    const output = new AcpOutput(session.id, new SessionAcpChannel(client, session.id));
    try {
      for (const entry of sessionEntriesWithActiveProjection(session, this.projections.get(session.id))) {
        await replayEntry(output, entry);
      }
      const activeTurn = session.turns.find((turn) => turn.state.status === "active");
      if (activeTurn) await output.turnState(activeTurn.state);
    } finally {
      await activeChannel?.finishResume(client);
    }
    return { configOptions: reasoningConfigOptions(this.reasoningCapability(session), session.reasoningOverride) };
  }

  private async resumeSession(
    params: acp.ResumeSessionRequest,
    client: acp.AgentContext,
  ): Promise<acp.ResumeSessionResponse> {
    const session = await this.requireSession(params.sessionId, params.cwd);
    const activeChannel = this.channels.get(session.id);
    activeChannel?.beginResume();
    try {
      const cursor = readSessionResumeMeta(params._meta);
      if (cursor) {
        const turn = session.turns.find((item) => item.turnId === cursor.turnId);
        if (!turn) throw new acp.RequestError(-32602, `恢复的 Turn 不存在: ${cursor.turnId}`);
        const entries = sessionEntriesWithActiveProjection(session, this.projections.get(session.id))
          .filter((entry) => entry.turnId === cursor.turnId);
        const output = new AcpOutput(session.id, new SessionAcpChannel(client, session.id));
        for (const entry of entries) await replayEntryDelta(output, entry, cursor, turn.state.status !== "active");
        await output.turnState(turn.state);
      }
    } finally {
      await activeChannel?.finishResume(client);
    }
    return { configOptions: reasoningConfigOptions(this.reasoningCapability(session), session.reasoningOverride) };
  }

  private async closeSession(params: acp.CloseSessionRequest): Promise<void> {
    this.cancel(params.sessionId);
    this.channels.get(params.sessionId)?.close();
  }

  private async setSessionConfigOption(
    params: acp.SetSessionConfigOptionRequest,
  ): Promise<acp.SetSessionConfigOptionResponse> {
    if (params.configId !== REASONING_CONFIG_ID || typeof params.value !== "string" || !isReasoningProfile(params.value)) {
      throw new acp.RequestError(-32602, "不支持的 Session Config Option");
    }
    const value = params.value;
    return this.serializeSessionState(params.sessionId, async () => {
      if (this.active.has(params.sessionId)) {
        throw new acp.RequestError(-32000, "回答生成期间不能修改思考强度");
      }
      const current = await this.sessions.get(params.sessionId);
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

  private reasoningCapability(session: SessionRecord): ModelReasoningCapability | undefined {
    const selected = this.models?.get(session.modelStudentId);
    if (selected) return selected.supports.reasoning;
    return session.modelStudentId === this.runtime.model.student.id
      ? effectiveReasoningCapability(this.runtime.model)
      : undefined;
  }

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
      const reserved = await this.serializeSessionState(params.sessionId, async () => {
        if (this.active.has(params.sessionId)) {
          throw new acp.RequestError(-32000, "这个会话已有一轮回答正在生成");
        }
        const current = await this.sessions.get(params.sessionId);
        if (!await this.bindings.agentExists(current.agentId)) {
          throw new acp.RequestError(
            -32002,
            "该会话绑定的 Agent 已删除，不能继续对话",
            { code: "SESSION_AGENT_DELETED", retryable: false },
          );
        }
        const requestedIds = promptMeta?.artifactMentions?.map((item) => item.artifactId) ?? [];
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
    const detachClient = () => channel.detach(client);
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
        await this.sessions.transitionTurn(session.id, turnId, "finalizing").catch(() => undefined);
        await this.sessions.finishTurn(session.id, turnId, "failed", {
          entryIds: [entryIdentity(user)],
          error: { code: "TURN_START_FAILED", message: "该 Turn 启动失败", retryable: true },
        }).catch(() => undefined);
      }
      requestSignal.removeEventListener("abort", detachClient);
      channel.close();
      this.channels.delete(session.id);
      this.projections.delete(session.id);
      this.active.delete(session.id);
      throw error;
    }

    try {
      const runtimeHistory = session.experimentRef && this.experiments
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
              projection.streamingSessionEntries.flatMap((entry) => entry.type === "message" && entry.role === "assistant" ? [entry.text] : []),
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

  private cancel(sessionId: string): void {
    this.pendingPrompts.get(sessionId)?.abort();
    this.active.get(sessionId)?.abort();
  }

  /**
   * ACP handlers are asynchronous and may interleave even on one connection.
   * Serialize only the short state transition that either reserves a Turn or
   * changes its Session-scoped configuration; the model run remains concurrent
   * across different Sessions.
   */
  private async serializeSessionState<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionStateOperations.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.sessionStateOperations.set(sessionId, current);
    try {
      return await current;
    } finally {
      if (this.sessionStateOperations.get(sessionId) === current) {
        this.sessionStateOperations.delete(sessionId);
      }
    }
  }

  private async requireSession(id: string, cwd: string): Promise<SessionRecord> {
    const session = await this.sessions.get(id);
    if (session.cwd !== cwd) throw new Error("会话 cwd 与请求不一致");
    return session;
  }
}

function effectiveReasoningCapability(model: import("../model/model-provider.js").ModelProvider): ModelReasoningCapability | undefined {
  if (!model.reasoningCapability) return undefined;
  const capability = structuredClone(model.reasoningCapability);
  const configuredDefault = model.student.generationDefaults.reasoningProfile;
  if (configuredDefault) capability.defaultProfile = configuredDefault;
  return capability;
}

class TurnProjection implements RunObserver {
  readonly streamingSessionEntries: SessionEntry[] = [];
  private readonly messages = new Map<number, SessionMessageEntry>();
  private readonly thoughts = new Map<number, SessionThoughtEntry>();
  private readonly messageChunks = new Map<number, number>();
  private readonly thoughtChunks = new Map<number, number>();
  private readonly closedRounds = new Set<number>();
  private runtimeFacts: RuntimeTurnSnapshot | undefined;
  private readonly capabilityFacts: NonNullable<import("../repository/session-types.js").TurnExecutionRecord["capabilitySnapshots"]> = [];
  private readonly roundFacts: NonNullable<import("../repository/session-types.js").TurnExecutionRecord["modelRounds"]> = [];
  private usageFacts: TurnTokenUsage | undefined;

  constructor(
    private readonly sessionId: string,
    private readonly turnId: string,
    private readonly promptEntry: SessionMessageEntry,
    private readonly output: AcpOutput,
    private readonly channel: SessionAcpChannel,
    private readonly sessions: SessionRepository,
    private readonly signal: AbortSignal,
  ) {}

  matchesTurn(turnId: string): boolean { return this.turnId === turnId; }

  entriesSnapshot(): SessionEntry[] { return structuredClone(this.streamingSessionEntries); }

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

  async turnSnapshot(facts: RuntimeTurnSnapshot): Promise<void> {
    this.runtimeFacts = structuredClone(facts);
    await this.sessions.checkpointTurn(this.sessionId, this.turnId, runtimeTurnFacts(facts));
  }

  async capabilitySnapshot(generation: number, hash: string, snapshot: RuntimeCapabilitySnapshot): Promise<void> {
    if (this.capabilityFacts.some((item) => item.generation === generation)) return;
    this.capabilityFacts.push({ generation, hash, snapshot: structuredClone(snapshot) });
    await this.sessions.checkpointTurn(this.sessionId, this.turnId, {
      capabilitySnapshots: structuredClone(this.capabilityFacts),
    });
  }

  async modelRoundStarted(facts: RuntimeModelRoundSnapshot): Promise<void> {
    this.roundFacts.push(structuredClone(facts));
    await this.sessions.checkpointTurn(this.sessionId, this.turnId, {
      modelRounds: structuredClone(this.roundFacts),
    });
  }

  async modelRoundCompleted(round: number, completedAt: string): Promise<void> {
    const current = this.roundFacts.find((item) => item.roundIndex === round);
    if (!current) return;
    current.completedAt = completedAt;
    await this.sessions.checkpointTurn(this.sessionId, this.turnId, {
      modelRounds: structuredClone(this.roundFacts),
    });
  }

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

  executionFacts(): Partial<import("../repository/session-types.js").TurnExecutionRecord> {
    return {
      ...(this.runtimeFacts ? runtimeTurnFacts(this.runtimeFacts) : {}),
      capabilitySnapshots: structuredClone(this.capabilityFacts),
      modelRounds: structuredClone(this.roundFacts),
      ...(this.usageFacts ? { usage: structuredClone(this.usageFacts) } : {}),
    };
  }

  async text(round: number, value: string): Promise<void> {
    const entry = this.ensureMessage(round);
    entry.text += value;
    const index = this.messageChunks.get(round) ?? 0;
    this.messageChunks.set(round, index + 1);
    await this.output.message("assistant", entry.messageId, value, {
      schemaVersion: 1,
      turnId: this.turnId,
      chunkIndex: index,
    });
  }

  async thought(round: number, value: string): Promise<void> {
    const entry = this.ensureThought(round);
    entry.text += value;
    const index = this.thoughtChunks.get(round) ?? 0;
    this.thoughtChunks.set(round, index + 1);
    await this.output.thought(entry.messageId, value, {
      schemaVersion: 1,
      turnId: this.turnId,
      chunkIndex: index,
    });
  }

  async roundComplete(round: number): Promise<void> {
    if (this.closedRounds.has(round)) return;
    this.closedRounds.add(round);
    // 最终 chunk 只是投影；先保存本轮完整内容，断线或进程中断后仍可回放。
    await this.sessions.checkpointTurnEntries(this.sessionId, this.turnId, this.streamingSessionEntries);
    const message = this.messages.get(round);
    if (message) {
      await this.output.message("assistant", message.messageId, "", {
        schemaVersion: 1,
        turnId: this.turnId,
        chunkIndex: this.messageChunks.get(round) ?? 0,
        final: true,
      });
    }
    const thought = this.thoughts.get(round);
    if (thought) {
      await this.output.thought(thought.messageId, "", {
        schemaVersion: 1,
        turnId: this.turnId,
        chunkIndex: this.thoughtChunks.get(round) ?? 0,
        final: true,
      });
    }
  }

  async providerContinuation(
    round: number,
    continuation: ProviderOpaqueContinuation,
    calls: import("../model/model-provider.js").ModelToolCall[],
  ): Promise<void> {
    const visibleEntryIds = [this.messages.get(round), this.thoughts.get(round)]
      .flatMap((entry) => entry ? [entry.messageId] : []);
    this.streamingSessionEntries.push({
      type: "provider_continuation",
      turnId: this.turnId,
      roundIndex: round,
      continuation: withProviderContinuationCorrelation(continuation, {
        messageIds: visibleEntryIds,
        toolCallIds: calls.flatMap((call) => call.id ? [call.id] : []),
      }),
      createdAt: new Date().toISOString(),
    });
  }

  async finalizeOpenRounds(): Promise<void> {
    const rounds = new Set([...this.messages.keys(), ...this.thoughts.keys()]);
    for (const round of rounds) await this.roundComplete(round);
  }

  async toolStart(call: PreparedToolCall): Promise<void> {
    console.warn("[tool] start", JSON.stringify({ sessionId: this.sessionId, turnId: this.turnId, toolCallId: call.id, name: call.name, permission: call.permission }));
    const entry: SessionToolCallEntry = {
      type: "tool_call",
      turnId: this.turnId,
      toolCallId: call.id,
      title: call.title,
      name: call.name,
      kind: call.kind,
      status: "pending",
      rawInput: call.arguments,
      content: [],
      locations: call.locations,
      createdAt: new Date().toISOString(),
    };
    this.streamingSessionEntries.push(entry);
    await this.sessions.checkpointTurnEntries(this.sessionId, this.turnId, [entry]);
    await this.output.toolCall({
      toolCallId: call.id,
      title: call.title,
      name: call.name,
      kind: call.kind,
      status: "pending",
      rawInput: call.arguments,
      locations: call.locations,
    });
  }

  async toolFinish(
    call: PreparedToolCall,
    status: acp.ToolCallStatus,
    result: ToolOutcome,
  ): Promise<void> {
    console.warn("[tool] finish", JSON.stringify({ sessionId: this.sessionId, turnId: this.turnId, toolCallId: call.id, name: call.name, status, outcomeStatus: result.status }));
    const entry = this.streamingSessionEntries.find(
      (item): item is SessionToolCallEntry =>
        item.type === "tool_call" && item.toolCallId === call.id,
    );
    const content = "content" in result ? result.content : [];
    const locations = "locations" in result ? result.locations : call.locations;
    if (entry) {
      entry.status = status;
      entry.rawOutput = result.rawOutput;
      entry.modelContent = result.modelContent;
      entry.outcomeStatus = result.status;
      entry.content = content;
      entry.locations = locations;
      await this.sessions.checkpointTurnEntries(this.sessionId, this.turnId, [entry]);
    }
    await this.output.toolUpdate({
      toolCallId: call.id,
      status,
      rawOutput: result.rawOutput,
      content,
      locations,
    });
  }

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
        locations: call.locations.map((location) => ({
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
      const response = await this.channel.request<acp.RequestPermissionResponse>(interaction.interactionId, this.signal, (client) => client.request(
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
      const response = await this.channel.request<acp.CreateElicitationResponse>(interaction.interactionId, this.signal, (client) => client.request(
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

  private ensureMessage(round: number): SessionMessageEntry {
    const existing = this.messages.get(round);
    if (existing) return existing;
    const entry = makeMessage("assistant", "", this.turnId, randomUUID());
    this.messages.set(round, entry);
    this.streamingSessionEntries.push(entry);
    return entry;
  }

  private ensureThought(round: number): SessionThoughtEntry {
    const existing = this.thoughts.get(round);
    if (existing) return existing;
    const entry: SessionThoughtEntry = {
      type: "thought",
      text: "",
      turnId: this.turnId,
      messageId: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.thoughts.set(round, entry);
    this.streamingSessionEntries.push(entry);
    return entry;
  }
}

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

function turnFailureFacts(failure: unknown): { code: string; message: string; retryable: boolean } {
  return failure instanceof RunFailure
    ? { code: failure.code, message: failure.message, retryable: failure.retryable }
    : { code: "INTERNAL_ERROR", message: "该 Turn 执行失败", retryable: true };
}

async function replayEntry(output: AcpOutput, entry: SessionEntry): Promise<void> {
  if (entry.type === "provider_continuation") return;
  if (entry.type === "message") {
    await output.message(entry.role, entry.messageId, entry.text, {
      schemaVersion: 1,
      turnId: entry.turnId,
      chunkIndex: 0,
      final: true,
      ...(entry.artifactMentions?.length ? { artifactMentions: entry.artifactMentions } : {}),
    });
  } else if (entry.type === "context_summary") {
    await output.contextSummary(entry.summary);
  } else if (entry.type === "token_usage") {
    await output.tokenUsage(entry.usage);
  } else if (entry.type === "thought") {
    await output.thought(entry.messageId, entry.text, {
      schemaVersion: 1,
      turnId: entry.turnId,
      chunkIndex: 0,
      final: true,
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

function sessionEntriesWithActiveProjection(
  session: SessionRecord,
  projection: TurnProjection | undefined,
): SessionEntry[] {
  const entries = structuredClone(session.sessionEntries);
  if (!projection) return entries;
  const indexes = new Map(entries.map((entry, index) => [entryIdentity(entry), index]));
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

async function replayEntryDelta(
  output: AcpOutput,
  entry: SessionEntry,
  cursor: SessionResumeMeta,
  turnCompleted: boolean,
): Promise<void> {
  if (entry.type === "message") {
    const current = cursor.messages[entry.messageId];
    const textLength = current?.textLength ?? 0;
    if (textLength > entry.text.length) throw new acp.RequestError(-32602, `消息恢复游标越界: ${entry.messageId}`);
    const text = entry.text.slice(textLength);
    const final = entry.role === "user" || turnCompleted;
    if (text.length === 0) return;
    await output.message(entry.role, entry.messageId, text, {
      schemaVersion: 1,
      turnId: entry.turnId,
      chunkIndex: current?.nextChunkIndex ?? 0,
      ...(final ? { final: true } : {}),
      ...(entry.artifactMentions?.length ? { artifactMentions: entry.artifactMentions } : {}),
    });
    return;
  }
  if (entry.type === "thought") {
    const current = cursor.thoughts[entry.messageId];
    const textLength = current?.textLength ?? 0;
    if (textLength > entry.text.length) throw new acp.RequestError(-32602, `思考恢复游标越界: ${entry.messageId}`);
    const text = entry.text.slice(textLength);
    if (text.length === 0) return;
    await output.thought(entry.messageId, text, {
      schemaVersion: 1,
      turnId: entry.turnId,
      chunkIndex: current?.nextChunkIndex ?? 0,
      ...(turnCompleted ? { final: true } : {}),
    });
    return;
  }
  await replayEntry(output, entry);
}

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

function estimateTokens(value: string): number {
  return value.length === 0 ? 0 : Math.max(1, Math.ceil(value.length / 4));
}

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
        pendingInteractions: state.pendingInteractions.map((interaction) => ({
          interactionId: interaction.interactionId,
          kind: interaction.kind,
          toolCallId: interaction.kind === "permission" ? interaction.toolCall.toolCallId : interaction.toolCallId,
          ...(interaction.kind === "permission" ? { toolName: interaction.toolCall.name } : {}),
        })),
      }
    : { status: state.status };
}

function promptText(content: acp.ContentBlock[]): string {
  return content
    .flatMap((item) => {
      if (item.type === "text") return [item.text];
      if (item.type === "resource_link") {
        return [`[资源链接] ${item.title ?? item.name}: ${item.uri}`];
      }
      return [];
    })
    .join("\n")
    .trim();
}

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

function entryIdentity(entry: SessionEntry): string {
  if (entry.type === "message" || entry.type === "thought") return `${entry.type}:${entry.messageId}`;
  if (entry.type === "tool_call") return `tool:${entry.toolCallId}`;
  if (entry.type === "provider_continuation") return `provider:${entry.turnId}:${entry.roundIndex}`;
  return `${entry.type}:${entry.turnId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
