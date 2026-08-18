import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import type { ToolCallStatus } from "@agentclientprotocol/sdk";
import type {
  ContextSummary,
  ContextSummaryItem,
  AgentRecord,
  ResolvedReasoningSnapshot,
} from "@kindergarten/contracts";
import {
  ContextAssembler,
  observeMessage,
  rebudgetContextMessages,
  replaceContextSegmentsInPlace,
  type ContextBuildResult,
} from "../conversation/context-assembler.js";
import {
  modelInputMessageCapacity,
  type ModelProvider,
  type ModelMessage,
  type ModelToolCall,
  type ModelToolDefinition,
  type ModelUsage,
} from "../model/model-provider.js";
import type { ProviderOpaqueContinuation } from "../model/provider-continuation.js";
import type { SessionEntry } from "../repository/session-types.js";
import {
  noopRuntimeObservationSink,
  type RuntimeObservationSink,
} from "@kindergarten/runtime-observation";
import { RunFailure, toRunFailure } from "./run-failure.js";
import {
  ToolCallLedger,
  ToolRuntime,
} from "../tools/tool-runtime.js";
import { prepareToolCall } from "../tools/tool-call-preparer.js";
import type {
  PreparedToolCall,
  ToolOutcome,
  ToolRegistryPort,
} from "../tools/tool-registry.js";
import type { RuntimeCapabilityResolverPort } from "../capability/runtime-capability-resolver.js";
import type { TurnScope } from "./turn-scope.js";
import type { RuntimeCapabilitySnapshot } from "../capability/capability-types.js";
import type { ModelContextSerialization } from "../model/model-provider.js";
import { resolveReasoning } from "../reasoning/reasoning-resolver.js";
import type { TurnActivePhase } from "@kindergarten/contracts";
import type { RepeatedInvalidToolCallGuardFactory } from "./repeated-invalid-tool-call-guard.js";
import {
  configuredSkillContextVersion,
  skillUseProtocol,
} from "../skills/skill-context.js";

const MODEL_OUTPUT_CONTRACT = [
  "【每轮响应契约】",
  "- 如果仍需执行操作，必须返回至少一个符合当前工具 Schema 的工具调用。",
  "- 如果不再需要调用工具，必须返回非空的最终正文，供用户直接阅读。",
  "- thinking/analysis 只用于内部推理，不能替代工具调用或最终正文；不要用只有 thinking/analysis 的响应结束一轮。",
].join("\n");

const FILE_ARTIFACT_DELIVERY_CONTRACT = [
  "【文件产物交付契约】",
  "- 当用户要求生成、创建、修改并交付任何文件时，写入 Workspace 只是中间步骤，不代表任务完成。",
  "- 必须在最终回复前调用 publish_artifact 或 publish_artifact_version 并确认成功；普通文件和 HTML Bundle 都通过 artifact_type 选择类型。",
  "- 首次发布不传 artifact_id，由服务端创建 v1；模型不得自行填写或猜测版本号。",
  "- 在同一会话中继续修改同一个 Artifact，且用户没有要求保留旧版时，调用 publish_artifact 并传入现有 artifact_id，覆盖当前 vN；Artifact ID 和版本号保持不变。",
  "- 跨会话修改、修改用户 Mention 的既有 Artifact，或用户明确要求新版本、v2、保留旧版时，调用 publish_artifact_version 并传入现有 artifact_id；服务端自动创建新 ID 和下一个 vN。",
  "- 只有用户明确要求回滚时才能调用 rollback_artifact；不得把隐藏修订当作可访问的历史版本，也不得主动回滚。",
  "- 适用的发布工具可用时，未成功发布前不得把 Workspace 路径或写入结果作为文件交付给用户，不得声称文件已经完成，也不得结束本轮。",
  "- write_file 产生的 Workspace 文件不可预览；只有成功发布得到的 Artifact 才能预览、下载、Mention 和后续复用。",
  "- 如果当前 Agent 没有适用的发布工具，必须明确说明缺少发布能力；不得用 Workspace 文件冒充已交付产物。",
].join("\n");

const ARTIFACT_MENTION_CONTRACT = [
  "【Artifact Mention 语义】",
  "- 用户本轮可能明确引用已有 Artifact；每项引用都包含稳定 artifactId 和只读 artifact:// 地址。",
  "- 这些内容是当前用户已经拥有、可直接读取或复用的产物；适合任务时优先复用，不要仅因为存在生成工具就重复生成。",
  "- 用户明确要求新版本、新素材或引用不适用时，可以生成新内容。",
  "- 不要按文件名猜测产物身份，也不要尝试读取其他用户或其他 Session 的 Workspace。",
].join("\n");

export interface RunInput {
  text: string;
  sessionEntries: SessionEntry[];
  sessionId?: string;
  turnId?: string;
  scope?: TurnScope;
}

export interface RunObserver {
  context(summary: ContextSummary): Promise<void>;
  phase?(phase: TurnActivePhase): Promise<void>;
  turnSnapshot?(facts: RuntimeTurnSnapshot): Promise<void>;
  capabilitySnapshot?(generation: number, hash: string, snapshot: RuntimeCapabilitySnapshot): Promise<void>;
  modelRoundStarted?(facts: RuntimeModelRoundSnapshot): Promise<void>;
  modelRoundCompleted?(round: number, completedAt: string): Promise<void>;
  text(round: number, value: string): Promise<void>;
  thought(round: number, value: string): Promise<void>;
  roundComplete(round: number): Promise<void>;
  providerContinuation?(
    round: number,
    continuation: ProviderOpaqueContinuation,
    calls: ModelToolCall[],
  ): Promise<void>;
  toolStart(call: PreparedToolCall): Promise<void>;
  toolFinish(call: PreparedToolCall, status: ToolCallStatus, result: ToolOutcome): Promise<void>;
  requestPermission(call: PreparedToolCall): Promise<boolean>;
  askUser(question: string, toolCallId: string): Promise<string>;
}

export interface RuntimeTurnSnapshot {
  modelStudentId: string;
  providerKind: string;
  model: string;
  agentId: string;
  agentSnapshotHash: string;
  agentSnapshot: Pick<AgentRecord, "systemPrompt" | "builtinTools" | "skills" | "mcps" | "historyPolicy" | "memoryPolicy">;
  resolvedReasoning: ResolvedReasoningSnapshot;
}

export interface RuntimeModelRoundSnapshot {
  roundIndex: number;
  capabilityGeneration: number;
  contextSummary: ContextSummary;
  providerInput: ModelContextSerialization;
  startedAt: string;
  resolvedReasoning: ResolvedReasoningSnapshot;
}

export interface ModelRoundUsage extends ModelUsage {
  round: number;
}

export interface TurnModelUsage extends ModelUsage {
  modelRequests: number;
  rounds: ModelRoundUsage[];
}

export interface RunResult {
  runId: string;
  reason: "stop" | "length" | "cancelled";
  usage: TurnModelUsage;
  fileRelativePaths: string[];
}

/** AgentRuntime 聚合完整能力；AgentRunner 只执行一次 session/prompt。 */
export class AgentRuntime {
  readonly runner: AgentRunner;

  constructor(
    readonly model: ModelProvider,
    readonly tools: ToolRuntime,
    context = new ContextAssembler(),
    observations: RuntimeObservationSink = noopRuntimeObservationSink,
    private readonly resolver?: RuntimeCapabilityResolverPort,
    repeatedInvalidToolCallGuardFactory?: RepeatedInvalidToolCallGuardFactory,
  ) {
    this.runner = new AgentRunner(
      model,
      tools,
      context,
      observations,
      resolver,
      repeatedInvalidToolCallGuardFactory,
    );
  }

  static fromRegistry(
    model: ModelProvider,
    registry: ToolRegistryPort,
    observations: RuntimeObservationSink = noopRuntimeObservationSink,
  ): AgentRuntime {
    return new AgentRuntime(model, new ToolRuntime(registry), new ContextAssembler(), observations);
  }

  run(input: RunInput, observer: RunObserver, signal: AbortSignal): Promise<RunResult> {
    return this.runner.run(input, observer, signal);
  }
}

export class AgentRunner {
  constructor(
    private readonly model: ModelProvider,
    private readonly tools: ToolRuntime,
    private readonly context: ContextAssembler,
    private readonly observations: RuntimeObservationSink,
    private readonly resolver?: RuntimeCapabilityResolverPort,
    private readonly repeatedInvalidToolCallGuardFactory?: RepeatedInvalidToolCallGuardFactory,
  ) {}

  async run(input: RunInput, observer: RunObserver, signal: AbortSignal): Promise<RunResult> {
    const runId = randomUUID();
    const startedAt = Date.now();
    await observer.phase?.("preparing_context");
    const resolved = input.scope && this.resolver ? await this.resolver.resolve(input.scope, input.text) : undefined;
    const model = resolved?.model ?? this.model;
    const repeatedInvalidToolCallGuard = this.repeatedInvalidToolCallGuardFactory?.(model.student);
    const tools = resolved?.tools ?? this.tools;
    const context = resolved?.context ?? this.context;
    const agentSystemPrompt = resolved?.agent.systemPrompt ?? "";
    const systemPrompt = appendRuntimeContracts(agentSystemPrompt);
    const reasoningCapability = model.reasoningCapability ?? {
      schemaVersion: 1 as const,
      control: "fixed" as const,
      adjustable: false,
      supportedProfiles: ["balanced" as const],
      defaultProfile: "balanced" as const,
    };
    const resolvedReasoning = resolveReasoning({
      providerKind: model.student.provider.kind,
      model: model.student.provider.model,
      capability: reasoningCapability,
      modelDefault: model.student.generationDefaults.reasoningProfile ?? reasoningCapability.defaultProfile,
      ...(input.scope?.reasoningOverride ? { sessionOverride: input.scope.reasoningOverride } : {}),
      native: (profile) => model.nativeReasoning?.(profile) ?? {},
    });
    const built = await context.buildObserved(input.sessionEntries, input.text, signal);
    const initialMessageCapacity = modelInputMessageCapacity(
      model,
      tools.registry.definitions.length > 0,
    );
    if (initialMessageCapacity !== undefined) {
      try {
        applyMessageBudget(built, initialMessageCapacity);
      } catch (error) {
        throw new RunFailure(
          errorText(error),
          "MODEL_INPUT_MESSAGE_LIMIT",
          false,
          { cause: error },
        );
      }
    }
    const messages = built.messages;
    const contextObservations = built.observations;
    let currentTools = tools;
    let currentResolved = resolved;
    let capabilityGeneration = 1;
    const fileRelativePaths = new Set<string>();
    let toolDefinitions = structuredClone(currentTools.registry.definitions);
    let capabilitySnapshot = structuredClone(currentTools.registry.capabilitySnapshot());
    const ledger = new ToolCallLedger();
    const roundUsages: ModelRoundUsage[] = [];
    let modelRequests = 0;
    const observed = new ObservedRunObserver(observer, this.observations, runId);
    const firstContextSummary = buildContextSummary(
      input.turnId ?? runId,
      model,
      systemPrompt,
      toolDefinitions,
      built,
    );
    await observed.context(firstContextSummary);
    if (resolved) {
      await observed.turnSnapshot({
        modelStudentId: model.student.id,
        providerKind: model.student.provider.kind,
        model: model.student.provider.model,
        agentId: resolved.agent.agentId,
        agentSnapshotHash: resolved.agentSnapshotHash,
        agentSnapshot: {
          systemPrompt: resolved.agent.systemPrompt,
          builtinTools: structuredClone(resolved.agent.builtinTools),
          skills: structuredClone(resolved.agent.skills),
          mcps: structuredClone(resolved.agent.mcps),
          historyPolicy: structuredClone(resolved.agent.historyPolicy),
          memoryPolicy: structuredClone(resolved.agent.memoryPolicy),
        },
        resolvedReasoning,
      });
      await observed.capabilitySnapshot(capabilityGeneration, resolved.capabilityHash, capabilitySnapshot);
    }
    this.observations.emit({
      type: "turn_started",
      runId,
      sessionId: input.sessionId ?? `runtime:${runId}`,
      turnId: input.turnId ?? runId,
      startedAt,
      resolvedReasoning: structuredClone(resolvedReasoning),
      variant: variantSnapshot(
        model,
        systemPrompt,
        toolDefinitions.map((tool) => tool.function.name),
        capabilitySnapshot,
      ),
    });

    for (let round = 0; ; round += 1) {
      const messageCapacity = modelInputMessageCapacity(model);
      if (messageCapacity !== undefined) {
        try {
          applyMessageBudget(built, messageCapacity);
        } catch (error) {
          const failure = new RunFailure(
            errorText(error),
            "MODEL_INPUT_MESSAGE_LIMIT",
            false,
            { cause: error },
          );
          this.runtimeError(runId, "turn", failure);
          this.completeTurn(runId, "failed", "resource_limit");
          throw failure;
        }
      }
      await observed.phase("model_streaming");
      modelRequests += 1;
      const roundId = `${runId}:round:${round}`;
      const roundStartedAt = new Date().toISOString();
      observed.enterRound(roundId);
      this.observations.emit({
        type: "model_round_started",
        runId,
        roundId,
        index: round,
        startedAt: Date.now(),
        resolvedReasoning: structuredClone(resolvedReasoning),
        context: {
          messages: [
            observeMessage(
              { role: "system", content: systemPrompt },
              "system",
              "system-prompt",
            ),
            ...structuredClone(contextObservations),
          ],
          truncatedSourceIds: [...built.truncatedSourceIds],
        },
      });
      let content = "";
      let thinking = "";
      let reason: "stop" | "length" | "cancelled" = "stop";
      const calls = new Map<string, ModelToolCall>();
      let firstTokenSeen = false;
      let roundUsage: ModelUsage | undefined;
      let providerOpaqueContinuation: ProviderOpaqueContinuation | undefined;
      const modelInput = { systemPrompt, messages, tools: toolDefinitions, reasoning: resolvedReasoning } satisfies import("../model/model-provider.js").ModelInput;
      await observed.modelRoundStarted({
        roundIndex: round,
        capabilityGeneration,
        contextSummary: buildContextSummary(input.turnId ?? runId, model, systemPrompt, toolDefinitions, {
          ...built,
          messages: structuredClone(messages),
          observations: structuredClone(contextObservations),
        }),
        providerInput: serializeModelInput(model, modelInput),
        startedAt: roundStartedAt,
        resolvedReasoning,
      });

      try {
        for await (const event of model.stream(modelInput, signal)) {
          if (
            !firstTokenSeen &&
            (event.type === "text_delta" ||
              event.type === "thinking_delta" ||
              (event.type === "tool_calls" && event.calls.length > 0))
          ) {
            firstTokenSeen = true;
            this.observations.emit({
              type: "model_round_first_token",
              runId,
              roundId,
              at: Date.now(),
            });
          }
          if (event.type === "text_delta") {
            content += event.text;
            await observed.text(round, event.text);
          } else if (event.type === "thinking_delta") {
            thinking += event.text;
            await observed.thought(round, event.text);
          } else if (event.type === "tool_calls") {
            for (const call of event.calls) calls.set(toolCallKey(call), call);
          } else if (event.type === "provider_continuation") {
            providerOpaqueContinuation = structuredClone(event.continuation);
          } else if (event.type === "usage") {
            roundUsage = mergeUsage(roundUsage, event);
            this.observations.emit({
              type: "model_round_usage",
              runId,
              roundId,
              ...(event.inputTokens !== undefined ? { inputTokens: event.inputTokens } : {}),
              ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}),
              ...(event.cachedInputTokens !== undefined ? { cachedInputTokens: event.cachedInputTokens } : {}),
              ...(event.reasoningOutputTokens !== undefined ? { reasoningOutputTokens: event.reasoningOutputTokens } : {}),
            });
          } else if (event.type === "finish") {
            reason = event.reason;
          }
        }
      } catch (error) {
        if (isAbort(error) || signal.aborted) {
          this.completeTurn(runId, "cancelled", "cancelled");
          return {
            runId,
            reason: "cancelled",
            usage: aggregateUsage(modelRequests, roundUsages),
            fileRelativePaths: [...fileRelativePaths],
          };
        }
        this.runtimeError(runId, "model", error);
        this.completeTurn(runId, "failed");
        // 模型流无法继续时才提升为 Turn 级失败；具体错误文本保持不变。
        throw toRunFailure(error);
      }

      if (roundUsage) roundUsages.push({ round, ...roundUsage });

      this.observations.emit({
        type: "model_round_completed",
        runId,
        roundId,
        completedAt: Date.now(),
        stopReason: reason,
        output: {
          text: content,
          ...(thinking ? { thinking } : {}),
        },
      });
      const modelCalls = [...calls.values()].toSorted(compareToolCallOrder);
      if (providerOpaqueContinuation) {
        await observed.providerContinuation(
          round,
          providerOpaqueContinuation,
          modelCalls,
        );
      }
      await observed.modelRoundCompleted(round, new Date().toISOString());
      await observed.roundComplete(round);
      const outcome = resolveModelResponse({ content, thinking, calls: modelCalls, reason });
      if (outcome.kind === "cancelled") {
        this.completeTurn(runId, "cancelled", "cancelled");
        return {
          runId,
          reason: "cancelled",
          usage: aggregateUsage(modelRequests, roundUsages),
          fileRelativePaths: [...fileRelativePaths],
        };
      }
      if (outcome.kind === "truncated") {
        const failure = new RunFailure(
          "模型回答因输出长度限制被截断，当前 Turn 未完成",
          "MODEL_OUTPUT_TRUNCATED",
          true,
        );
        this.runtimeError(runId, "model", failure);
        this.completeTurn(runId, "failed", "length");
        throw failure;
      }
      if (outcome.kind === "invalid") {
        const message = outcome.reason === "thinking_only"
          ? "模型只有思考过程，没有返回工具调用或最终正文"
          : "模型没有返回工具调用或最终正文";
        const failure = new RunFailure(message, "EMPTY_ASSISTANT_RESPONSE", true);
        this.runtimeError(runId, "model", failure);
        this.completeTurn(runId, "failed", "invalid_model_output");
        throw failure;
      }
      if (outcome.kind === "final") {
        this.completeTurn(runId, "completed", reason);
        return {
          runId,
          reason,
          usage: aggregateUsage(modelRequests, roundUsages),
          fileRelativePaths: [...fileRelativePaths],
        };
      }

      const prepared = modelCalls.map((call, index) =>
        ({ modelCall: call, call: prepareToolCall(currentTools.registry, call, `${randomUUID()}:${index}`) }),
      );
      const assistantMessage = {
        role: "assistant",
        content,
        ...(thinking ? { thinking } : {}),
        toolCalls: prepared.map(({ modelCall, call }) => ({
          id: call.id,
          name: modelCall.name,
          arguments: modelCall.arguments,
        })),
        ...(providerOpaqueContinuation
          ? { providerOpaqueContinuation: structuredClone(providerOpaqueContinuation) }
          : {}),
      } satisfies ModelMessage;
      messages.push(assistantMessage);
      contextObservations.push(observeMessage(
        assistantMessage,
        "current_turn",
        `round:${round}:assistant`,
      ));

      let batch;
      try {
        await observed.phase("tool_execution");
        batch = await currentTools.executeBatch(
          prepared.map((item) => item.call),
          observed,
          ledger,
          signal,
        );
      } catch (error) {
        if (isAbort(error) || signal.aborted) {
          this.completeTurn(runId, "cancelled", "cancelled");
          return {
            runId,
            reason: "cancelled",
            usage: aggregateUsage(modelRequests, roundUsages),
            fileRelativePaths: [...fileRelativePaths],
          };
        }
        this.runtimeError(runId, "tool_runtime", error);
        this.completeTurn(runId, "failed");
        // ToolRuntime 正常会把工具失败收敛为 ToolOutcome；到达这里说明执行链本身已中断。
        throw toRunFailure(error);
      }
      for (let index = 0; index < prepared.length; index += 1) {
        const item = prepared[index];
        const outcome = batch.outcomes[index];
        if (!item || !outcome) continue;
        const toolMessage = {
          role: "tool",
          toolName: item.call.name,
          toolCallId: item.call.id,
          content: outcome.modelContent,
        } satisfies import("../model/model-provider.js").ModelMessage;
        messages.push(toolMessage);
        contextObservations.push(observeMessage(toolMessage, "tool_result", item.call.id));
        outcome.effects?.fileRelativePaths?.forEach((path) => fileRelativePaths.add(path));
      }
      const exhaustedCall = repeatedInvalidToolCallGuard?.inspect(
        round,
        prepared.map((item) => item.call),
        batch.outcomes,
      );
      if (exhaustedCall) {
        const failure = new RunFailure(
          `工具 ${exhaustedCall.toolName} 在同一用户 Turn 的 ${exhaustedCall.attempts} 个模型轮中重复提交完全相同的无效参数，已结束当前用户 Turn`,
          "TOOL_ARGUMENT_RETRY_LIMIT",
          false,
        );
        this.runtimeError(runId, "turn", failure);
        this.completeTurn(runId, "failed", "resource_limit");
        throw failure;
      }
      if (input.scope && this.resolver && batch.outcomes.some((item) => item.effects?.capabilitiesChanged)) {
        const next = await this.resolver.resolve(input.scope, input.text);
        if (next.capabilityHash !== currentResolved?.capabilityHash) {
          currentResolved = next;
          currentTools = next.tools;
          toolDefinitions = structuredClone(currentTools.registry.definitions);
          capabilitySnapshot = structuredClone(currentTools.registry.capabilitySnapshot());
          const refreshed = await next.context.buildObserved([], "", signal);
          replaceContextSegmentsInPlace(built, refreshed.segments);
          capabilityGeneration += 1;
          this.observations.emit({
            type: "capability_generation_changed",
            runId,
            generation: capabilityGeneration,
            hash: next.capabilityHash,
            at: Date.now(),
          });
          await observed.capabilitySnapshot(capabilityGeneration, next.capabilityHash, capabilitySnapshot);
        }
      }
    }
  }

  private runtimeError(
    runId: string,
    scope: "model" | "tool_runtime" | "turn",
    error: unknown,
  ): void {
    this.observations.emit({
      type: "runtime_error",
      runId,
      scope,
      message: errorText(error),
      at: Date.now(),
    });
  }

  private completeTurn(
    runId: string,
    status: "completed" | "failed" | "cancelled",
    stopReason?: string,
  ): void {
    this.observations.emit({
      type: "turn_completed",
      runId,
      status,
      completedAt: Date.now(),
      ...(stopReason ? { stopReason } : {}),
    });
  }
}

function applyMessageBudget(built: ContextBuildResult, maxMessages: number): void {
  const budgeted = rebudgetContextMessages(
    built.messages,
    built.observations,
    maxMessages,
  );
  built.messages.splice(0, built.messages.length, ...budgeted.messages);
  built.observations.splice(0, built.observations.length, ...budgeted.observations);
  built.truncatedSourceIds.splice(
    0,
    built.truncatedSourceIds.length,
    ...new Set([...built.truncatedSourceIds, ...budgeted.truncatedSourceIds]),
  );
}

function mergeUsage(current: ModelUsage | undefined, next: ModelUsage): ModelUsage {
  return {
    ...(next.inputTokens !== undefined
      ? { inputTokens: next.inputTokens }
      : current?.inputTokens !== undefined ? { inputTokens: current.inputTokens } : {}),
    ...(next.outputTokens !== undefined
      ? { outputTokens: next.outputTokens }
      : current?.outputTokens !== undefined ? { outputTokens: current.outputTokens } : {}),
    ...(next.cachedInputTokens !== undefined
      ? { cachedInputTokens: next.cachedInputTokens }
      : current?.cachedInputTokens !== undefined ? { cachedInputTokens: current.cachedInputTokens } : {}),
    ...(next.reasoningOutputTokens !== undefined
      ? { reasoningOutputTokens: next.reasoningOutputTokens }
      : current?.reasoningOutputTokens !== undefined ? { reasoningOutputTokens: current.reasoningOutputTokens } : {}),
  };
}

function aggregateUsage(
  modelRequests: number,
  rounds: ModelRoundUsage[],
): TurnModelUsage {
  return {
    modelRequests,
    rounds: structuredClone(rounds),
    ...sumUsageField(rounds, "inputTokens"),
    ...sumUsageField(rounds, "outputTokens"),
    ...sumUsageField(rounds, "cachedInputTokens"),
    ...sumUsageField(rounds, "reasoningOutputTokens"),
  };
}

function sumUsageField<K extends keyof ModelUsage>(
  rounds: ModelRoundUsage[],
  key: K,
): Pick<ModelUsage, K> | Record<string, never> {
  const values = rounds.flatMap((round) =>
    typeof round[key] === "number" ? [round[key] as number] : [],
  );
  return values.length > 0
    ? { [key]: values.reduce((total, value) => total + value, 0) } as Pick<ModelUsage, K>
    : {};
}

class ObservedRunObserver implements RunObserver {
  private roundId = "";

  constructor(
    private readonly delegate: RunObserver,
    private readonly observations: RuntimeObservationSink,
    private readonly runId: string,
  ) {}

  enterRound(roundId: string): void { this.roundId = roundId; }
  context(summary: ContextSummary): Promise<void> { return this.delegate.context(summary); }
  phase(phase: TurnActivePhase): Promise<void> { return this.delegate.phase?.(phase) ?? Promise.resolve(); }
  turnSnapshot(facts: RuntimeTurnSnapshot): Promise<void> { return this.delegate.turnSnapshot?.(facts) ?? Promise.resolve(); }
  capabilitySnapshot(generation: number, hash: string, snapshot: RuntimeCapabilitySnapshot): Promise<void> { return this.delegate.capabilitySnapshot?.(generation, hash, snapshot) ?? Promise.resolve(); }
  modelRoundStarted(facts: RuntimeModelRoundSnapshot): Promise<void> { return this.delegate.modelRoundStarted?.(facts) ?? Promise.resolve(); }
  modelRoundCompleted(round: number, completedAt: string): Promise<void> { return this.delegate.modelRoundCompleted?.(round, completedAt) ?? Promise.resolve(); }
  text(round: number, value: string): Promise<void> { return this.delegate.text(round, value); }
  thought(round: number, value: string): Promise<void> { return this.delegate.thought(round, value); }
  roundComplete(round: number): Promise<void> { return this.delegate.roundComplete(round); }
  providerContinuation(
    round: number,
    continuation: ProviderOpaqueContinuation,
    calls: ModelToolCall[],
  ): Promise<void> {
    return this.delegate.providerContinuation?.(round, continuation, calls) ?? Promise.resolve();
  }

  async toolStart(call: PreparedToolCall): Promise<void> {
    this.observations.emit({
      type: "tool_call_started",
      runId: this.runId,
      roundId: this.roundId,
      toolCallId: call.id,
      name: call.name,
      arguments: structuredClone(call.arguments),
      signature: call.dedupeKey,
      permission: call.permission,
      startedAt: Date.now(),
    });
    await this.delegate.toolStart(call);
  }

  async toolFinish(
    call: PreparedToolCall,
    status: ToolCallStatus,
    result: ToolOutcome,
  ): Promise<void> {
    this.observations.emit({
      type: "tool_call_completed",
      runId: this.runId,
      toolCallId: call.id,
      status: result.status,
      completedAt: Date.now(),
      ...(result.error
        ? { error: { category: result.error.category, message: result.error.message } }
        : {}),
      output: structuredClone(result.rawOutput),
    });
    await this.delegate.toolFinish(call, status, result);
  }

  async requestPermission(call: PreparedToolCall): Promise<boolean> {
    const allowed = await this.delegate.requestPermission(call);
    this.observations.emit({
      type: "permission_decided",
      runId: this.runId,
      toolCallId: call.id,
      required: true,
      decision: allowed ? "allowed" : "denied",
      decidedAt: Date.now(),
    });
    return allowed;
  }

  async askUser(question: string, toolCallId: string): Promise<string> {
    return this.delegate.askUser(question, toolCallId);
  }
}

function variantSnapshot(
  model: ModelProvider,
  systemPrompt: string,
  toolNames: string[],
  capabilities: ReturnType<ToolRegistryPort["capabilitySnapshot"]>,
) {
  return {
    studentId: model.student.id,
    studentName: model.student.name,
    provider: model.student.provider.kind,
    model: model.student.provider.model,
    ...(model.student.generationDefaults.temperature !== undefined
      ? { temperature: model.student.generationDefaults.temperature }
      : {}),
    systemPromptHash: createHash("sha256")
      .update(systemPrompt)
      .digest("hex"),
    runtimeVersion: "D2P-1.2",
    toolNames,
    capabilities,
  };
}

export function buildContextSummary(
  turnId: string,
  model: ModelProvider,
  systemPrompt: string,
  tools: ModelToolDefinition[],
  built: ContextBuildResult,
): ContextSummary {
  const items: ContextSummaryItem[] = [
    {
      id: "system-prompt",
      kind: "system_instruction",
      title: "Agent 基础指令",
      detail: "行为边界、工具使用与回答要求",
      estimatedTokens: estimateTokens(systemPrompt),
      trust: "trusted",
      raw: model.serializeContext({ kind: "system", content: systemPrompt }),
    },
  ];

  if (tools.length > 0) {
    items.push({
      id: "available-tools",
      kind: "available_tools",
      title: "可用工具",
      detail: tools.map((tool) => tool.function.name).join("、"),
      itemCount: tools.length,
      estimatedTokens: estimateTokens(JSON.stringify(tools)),
      trust: "trusted",
      raw: model.serializeContext({ kind: "tools", tools }),
    });
  }

  for (const segment of built.segments) {
    const messages = contextMessages(built, (item) =>
      item.source === segment.kind && item.sourceId === segment.sourceId
    );
    items.push({
      id: segment.id,
      kind: segment.kind,
      title: segment.summary.title,
      estimatedTokens: segment.estimatedTokens,
      trust: segment.trust,
      raw: model.serializeContext({ kind: "messages", messages }),
      ...(segment.summary.detail ? { detail: segment.summary.detail } : {}),
      ...(segment.summary.itemCount !== undefined
        ? { itemCount: segment.summary.itemCount }
        : {}),
    });
  }

  const history = built.observations.filter(
    (item) => item.source === "session_history" || item.source === "tool_result",
  );
  if (history.length > 0) {
    const toolResults = history.filter((item) => item.source === "tool_result").length;
    const messageCount = history.length - toolResults;
    items.push({
      id: "session-history",
      kind: "session_history",
      title: "对话历史",
      detail: [
        messageCount > 0 ? `${messageCount} 条消息` : "",
        toolResults > 0 ? `${toolResults} 条工具结果` : "",
      ].filter(Boolean).join(" · "),
      itemCount: history.length,
      estimatedTokens: history.reduce((total, item) => total + item.estimatedTokens, 0),
      trust: "trusted",
      raw: model.serializeContext({
        kind: "messages",
        messages: contextMessages(
          built,
          (item) => item.source === "session_history" || item.source === "tool_result",
        ),
      }),
    });
  }

  if (built.truncatedSourceIds.length > 0) {
    items.push({
      id: "truncated-history",
      kind: "truncated_history",
      title: "较早历史已裁剪",
      detail: `${built.truncatedSourceIds.length} 个来源未进入本轮上下文`,
      itemCount: built.truncatedSourceIds.length,
      estimatedTokens: 0,
      trust: "trusted",
      raw: model.serializeContext({
        kind: "omitted",
        sourceIds: built.truncatedSourceIds,
      }),
    });
  }

  return {
    schemaVersion: 1,
    turnId,
    items,
    totalEstimatedTokens: items.reduce(
      (total, item) => total + item.estimatedTokens,
      0,
    ),
  };
}

function contextMessages(
  built: ContextBuildResult,
  select: (item: ContextBuildResult["observations"][number]) => boolean,
) {
  return built.messages.filter((_message, index) => {
    const item = built.observations[index];
    return item !== undefined && select(item);
  });
}

export function serializeModelInput(
  model: ModelProvider,
  input: import("../model/model-provider.js").ModelInput,
): ModelContextSerialization {
  if (model.serializeInput) return model.serializeInput(input);
  return {
    provider: model.student.provider.kind,
    model: model.student.provider.model,
    format: "json",
    value: JSON.stringify({
      system: model.serializeContext({ kind: "system", content: input.systemPrompt }).value,
      tools: model.serializeContext({ kind: "tools", tools: input.tools }).value,
      messages: model.serializeContext({ kind: "messages", messages: input.messages }).value,
    }, null, 2),
  };
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function toolCallKey(call: ModelToolCall): string {
  if (call.id) return call.id;
  if (call.index !== undefined) return `index:${call.index}`;
  return `${call.name}:${JSON.stringify(call.arguments)}`;
}

function compareToolCallOrder(left: ModelToolCall, right: ModelToolCall): number {
  if (left.index === undefined && right.index === undefined) return 0;
  if (left.index === undefined) return 1;
  if (right.index === undefined) return -1;
  return left.index - right.index;
}

type ModelResponseOutcome =
  | { kind: "cancelled" }
  | { kind: "truncated" }
  | { kind: "tool_calls" }
  | { kind: "final" }
  | { kind: "invalid"; reason: "thinking_only" | "empty" };

function resolveModelResponse(input: {
  content: string;
  thinking: string;
  calls: ModelToolCall[];
  reason: "stop" | "length" | "cancelled";
}): ModelResponseOutcome {
  if (input.reason === "cancelled") return { kind: "cancelled" };
  // 被截断的正文或 Tool Call 都可能不完整，不能产生完成状态或工具副作用。
  if (input.reason === "length") return { kind: "truncated" };
  if (input.calls.length > 0) return { kind: "tool_calls" };
  if (input.content.trim().length > 0) return { kind: "final" };
  return {
    kind: "invalid",
    reason: input.thinking.trim().length > 0 ? "thinking_only" : "empty",
  };
}

function appendRuntimeContracts(systemPrompt: string): string {
  const prompt = systemPrompt.trimEnd();
  const contracts = [
    MODEL_OUTPUT_CONTRACT,
    FILE_ARTIFACT_DELIVERY_CONTRACT,
    ARTIFACT_MENTION_CONTRACT,
    skillUseProtocol(configuredSkillContextVersion()),
  ].join("\n\n");
  return prompt ? `${prompt}\n\n${contracts}` : contracts;
}

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
