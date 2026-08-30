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
  traceModelInputMessage,
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
  type ToolResultMessage,
} from "../model/model-provider.js";
import type { ProviderOpaqueContinuation } from "../model/provider-continuation.js";
import type { SessionEntry } from "../repository/session-types.js";
import {
  noopRuntimeObservationSink,
  type RuntimePayloadEvidence,
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
import {
  configuredSkillContextVersion,
  skillUseProtocol,
} from "../skills/skill-context.js";
import {
  previewContextWindow,
  type ContextWindowPreview,
} from "../conversation/context-window-preview.js";
import {
  PRODUCT_CONFIG,
  type RuntimeExecutionBudget,
} from "@kindergarten/contracts";

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
  "- 修改已有文本文件的少量字符或局部代码时优先使用 edit_file 按行替换，不得为小范围修改用 write_file 重新输出完整文件；新建文件或整体重建时才使用 write_file。",
  "- edit_file 的旧文本零匹配或多匹配时，先用 read_file 读取当前内容并缩小到唯一片段，不得原参数重复调用。",
  "- 如果当前 Agent 没有适用的发布工具，必须明确说明缺少发布能力；不得用 Workspace 文件冒充已交付产物。",
].join("\n");

const ARTIFACT_MENTION_CONTRACT = [
  "【Artifact Mention 语义】",
  "- 用户本轮可能明确引用已有 Artifact；每项引用都包含稳定 artifactId 和只读 artifact:// 地址。",
  "- 这些内容是当前用户已经拥有、可直接读取或复用的产物；适合任务时优先复用，不要仅因为存在生成工具就重复生成。",
  "- 用户明确要求新版本、新素材或引用不适用时，可以生成新内容。",
  "- 不要按文件名猜测产物身份，也不要尝试读取其他用户或其他 Session 的 Workspace。",
].join("\n");

/** 描述「RunInput」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface RunInput {
  text: string;
  sessionEntries: SessionEntry[];
  sessionId?: string;
  turnId?: string;
  scope?: TurnScope;
}

/** 描述「RunObserver」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
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

/** 描述「RuntimeTurnSnapshot」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface RuntimeTurnSnapshot {
  modelStudentId: string;
  providerKind: string;
  model: string;
  agentId: string;
  agentSnapshotHash: string;
  agentSnapshot: Pick<AgentRecord, "systemPrompt" | "builtinTools" | "builtinSkills" | "skills" | "mcps" | "historyPolicy" | "memoryPolicy">;
  resolvedReasoning: ResolvedReasoningSnapshot;
}

/** 描述「RuntimeModelRoundSnapshot」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface RuntimeModelRoundSnapshot {
  roundIndex: number;
  capabilityGeneration: number;
  contextSummary: ContextSummary;
  providerInput: ModelContextSerialization;
  startedAt: string;
  resolvedReasoning: ResolvedReasoningSnapshot;
}

/** 描述「ModelRoundUsage」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ModelRoundUsage extends ModelUsage {
  round: number;
}

/** 描述「TurnModelUsage」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface TurnModelUsage extends ModelUsage {
  modelRequests: number;
  rounds: ModelRoundUsage[];
}

/** 描述「RunResult」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface RunResult {
  runId: string;
  reason: "stop" | "length" | "cancelled";
  usage: TurnModelUsage;
  fileRelativePaths: string[];
}

/** 描述「ContextWindowPreviewInput」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ContextWindowPreviewInput {
  sessionEntries: SessionEntry[];
  scope?: TurnScope;
}

/**
 * 进程级 Prompt Turn 准入计数器。
 *
 * `release` 自带幂等保护，确保成功、失败、取消和等待权限等所有退出路径只释放一次。
 */
export class RuntimeTurnAdmission {
  private active = 0;

  /** 原子取得一个进程级 Turn 名额；已满时不排队，直接让入口返回可重试繁忙错误。 */
acquire(limit: number): (() => void) | undefined {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Runtime 并发 Turn 上限必须是正整数");
    if (this.active >= limit) return undefined;
    this.active += 1;
    let released = false;
    return /** 幂等归还名额，防止多条终态清理路径把计数减成负数。 */ () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }

  /** 仅供容量诊断和测试读取，不允许调用方直接修改计数。 */
  get activeTurns(): number {
    return this.active;
  }
}

const processTurnAdmission = new RuntimeTurnAdmission();

/** AgentRuntime 聚合完整能力；AgentRunner 只执行一次 session/prompt。 */
export class AgentRuntime {
  readonly runner: AgentRunner;

  /** 初始化「AgentRuntime」所需依赖，不在构造阶段启动不可回收的后台任务。 */
  constructor(
    private readonly fallbackModel: ModelProvider | undefined,
    readonly tools: ToolRuntime,
    private readonly context = new ContextAssembler(),
    observations: RuntimeObservationSink = noopRuntimeObservationSink,
    private readonly resolver?: RuntimeCapabilityResolverPort,
    private readonly executionBudget: RuntimeExecutionBudget = PRODUCT_CONFIG.runtime,
    private readonly turnAdmission: RuntimeTurnAdmission = processTurnAdmission,
  ) {
    validateExecutionBudget(executionBudget);
    this.runner = new AgentRunner(
      fallbackModel,
      tools,
      context,
      observations,
      resolver,
      executionBudget,
    );
  }

  /** 根据已校验输入构建「fromRegistry」结果，不额外持有调用方的大对象。 */
static fromRegistry(
    model: ModelProvider,
    registry: ToolRegistryPort,
    observations: RuntimeObservationSink = noopRuntimeObservationSink,
  ): AgentRuntime {
    return new AgentRuntime(model, new ToolRuntime(registry), new ContextAssembler(), observations);
  }

  /** 执行「run」主流程，传播取消与失败并在结束时清理临时资源。 */
async run(input: RunInput, observer: RunObserver, signal: AbortSignal): Promise<RunResult> {
    const release = this.turnAdmission.acquire(this.executionBudget.maxConcurrentTurns);
    if (!release) {
      throw new RunFailure(
        `Remote 同时执行的 Prompt Turn 已达到 ${this.executionBudget.maxConcurrentTurns} 个`,
        "RUNTIME_CONCURRENCY_LIMIT",
        true,
      );
    }
    try {
      return await this.runner.run(input, observer, signal);
    } finally {
      // 所有终态统一经过此处，避免取消或异常路径泄漏进程级准入名额。
      release();
    }
  }

  /** 按与正式运行相同的冻结能力组装上下文预览，但不启动模型请求或工具副作用。 */
async previewContextWindow(
    input: ContextWindowPreviewInput,
    signal: AbortSignal,
  ): Promise<ContextWindowPreview | undefined> {
    const resolved = input.scope && this.resolver
      ? await this.resolver.resolve(input.scope, "")
      : undefined;
    const model = resolved?.model ?? this.fallbackModel;
    if (!model) return undefined;
    const tools = resolved?.tools ?? this.tools;
    return previewContextWindow({
      model,
      context: resolved?.context ?? this.context,
      systemPrompt: buildRuntimeSystemPrompt(resolved?.agent.systemPrompt ?? ""),
      tools: structuredClone(tools.registry.definitions),
      sessionEntries: structuredClone(input.sessionEntries),
      signal,
    });
  }
}

/** 描述「AgentRunner」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export class AgentRunner {
  /** 初始化「AgentRunner」所需依赖，不在构造阶段启动不可回收的后台任务。 */
  constructor(
    private readonly fallbackModel: ModelProvider | undefined,
    private readonly tools: ToolRuntime,
    private readonly context: ContextAssembler,
    private readonly observations: RuntimeObservationSink,
    private readonly resolver?: RuntimeCapabilityResolverPort,
    private readonly executionBudget: RuntimeExecutionBudget = PRODUCT_CONFIG.runtime,
  ) {}

  /** 执行「run」主流程，传播取消与失败并在结束时清理临时资源。 */
async run(input: RunInput, observer: RunObserver, signal: AbortSignal): Promise<RunResult> {
    const runId = randomUUID();
    const startedAt = Date.now();
    await observer.phase?.("preparing_context");
    const resolved = input.scope && this.resolver ? await this.resolver.resolve(input.scope, input.text) : undefined;
    const model = resolved?.model ?? this.fallbackModel;
    if (!model) {
      throw new RunFailure("当前 Session 绑定的 ModelStudent 不可用", "MODEL_UNAVAILABLE", false);
    }
    const tools = resolved?.tools ?? this.tools;
    const context = resolved?.context ?? this.context;
    const agentSystemPrompt = resolved?.agent.systemPrompt ?? "";
    const systemPrompt = buildRuntimeSystemPrompt(agentSystemPrompt);
    const reasoningCapability = model.reasoningCapability ?? {
      schemaVersion: 1 as const,
      control: "fixed" as const,
      adjustable: false,
      supportedProfiles: ["balanced" as const],
      defaultProfile: "balanced" as const,
    };
    const resolvedReasoning = input.scope?.frozenReasoning ?? resolveReasoning({
      providerKind: model.student.provider.kind,
      model: model.student.provider.model,
      capability: reasoningCapability,
      modelDefault: model.student.generationDefaults.reasoningProfile ?? reasoningCapability.defaultProfile,
      ...(input.scope?.reasoningOverride ? { sessionOverride: input.scope.reasoningOverride } : {}),
      native: /** 执行「native」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(profile) => model.nativeReasoning?.(profile) ?? {},
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
    const modelInputMessageTraces = built.messageTraces;
    let currentTools = tools;
    let currentResolved = resolved;
    let capabilityGeneration = 1;
    const fileRelativePaths = new Set<string>();
    let toolDefinitions = structuredClone(currentTools.registry.definitions);
    let capabilitySnapshot = structuredClone(currentTools.registry.capabilitySnapshot());
    if (resolved?.expectedFirstProviderInputHash) {
      const actual = createHash("sha256").update(serializeModelInput(model, {
        systemPrompt,
        messages: built.messages,
        tools: toolDefinitions,
        reasoning: resolvedReasoning,
      }).value).digest("hex");
      if (actual !== resolved.expectedFirstProviderInputHash) {
        throw new RunFailure("实验首轮输入与冻结预览不一致", "EXPERIMENT_INPUT_MISMATCH", false);
      }
    }
    const ledger = new ToolCallLedger();
    const roundUsages: ModelRoundUsage[] = [];
    let modelRequests = 0;
    let turnToolCallCount = 0;
    let turnToolArgumentBytes = 0;
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
          builtinSkills: structuredClone(resolved.agent.builtinSkills),
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
        toolDefinitions.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(tool) => tool.function.name),
        capabilitySnapshot,
      ),
    });

    for (let round = 0; ; round += 1) {
      if (round >= this.executionBudget.maxModelRounds) {
        const failure = new RunFailure(
          `当前 Turn 已达到 ${this.executionBudget.maxModelRounds} 个模型轮次上限`,
          "MODEL_ROUND_LIMIT",
          false,
        );
        this.runtimeError(runId, "turn", failure);
        this.completeTurn(runId, "failed", "resource_limit");
        throw failure;
      }
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
            traceModelInputMessage(
              { role: "system", content: systemPrompt },
              "system",
              "system-prompt",
            ),
            ...structuredClone(modelInputMessageTraces),
          ],
          truncatedSourceIds: [...built.truncatedSourceIds],
        },
      });
      let content = "";
      let thinking = "";
      let contentBytes = 0;
      let thinkingBytes = 0;
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
          messageTraces: structuredClone(modelInputMessageTraces),
        }),
        providerInput: serializeModelInput(model, modelInput),
        startedAt: roundStartedAt,
        resolvedReasoning,
      });

      const idleController = new AbortController();
      const streamSignal = AbortSignal.any([signal, idleController.signal]);
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let idleExpired = false;
      const armIdleTimer = /** 每收到一个 Provider 事件就重置看门狗，只把连续静默判为流失活。 */
() => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(/** 执行受生命周期约束的定时任务，调用方负责在结束时取消句柄。 */
() => {
          idleExpired = true;
          idleController.abort();
        }, this.executionBudget.modelStreamIdleTimeoutMs);
        idleTimer.unref?.();
      };
      try {
        armIdleTimer();
        for await (const event of model.stream(modelInput, streamSignal)) {
          // 每个 Provider 事件都证明流仍存活；只有连续静默才触发空闲超时。
          armIdleTimer();
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
            contentBytes += Buffer.byteLength(event.text);
            if (contentBytes > this.executionBudget.maxTextBytesPerRound) {
              throw new RunFailure(
                `单轮模型正文超过 ${this.executionBudget.maxTextBytesPerRound} 字节`,
                "MODEL_TEXT_BYTES_LIMIT",
                false,
              );
            }
            content += event.text;
            await observed.text(round, event.text);
          } else if (event.type === "thinking_delta") {
            thinkingBytes += Buffer.byteLength(event.text);
            if (thinkingBytes > this.executionBudget.maxThinkingBytesPerRound) {
              throw new RunFailure(
                `单轮模型 thinking 超过 ${this.executionBudget.maxThinkingBytesPerRound} 字节`,
                "MODEL_THINKING_BYTES_LIMIT",
                false,
              );
            }
            thinking += event.text;
            await observed.thought(round, event.text);
          } else if (event.type === "tool_calls") {
            for (const call of event.calls) {
              const argumentBytes = jsonBytes(call.arguments, "模型工具参数无法序列化");
              if (argumentBytes > this.executionBudget.maxToolArgumentBytesPerCall) {
                throw new RunFailure(
                  `工具 ${call.name} 的参数超过 ${this.executionBudget.maxToolArgumentBytesPerCall} 字节`,
                  "TOOL_ARGUMENT_BYTES_LIMIT",
                  false,
                );
              }
              calls.set(toolCallKey(call), call);
            }
            if (calls.size > this.executionBudget.maxToolCallsPerRound) {
              throw new RunFailure(
                `单轮工具调用超过 ${this.executionBudget.maxToolCallsPerRound} 个`,
                "TOOL_CALL_ROUND_LIMIT",
                false,
              );
            }
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
        if (idleExpired) {
          const failure = new RunFailure(
            `模型流连续 ${this.executionBudget.modelStreamIdleTimeoutMs} 毫秒没有返回事件`,
            "MODEL_STREAM_IDLE_TIMEOUT",
            true,
            { cause: error },
          );
          this.runtimeError(runId, "model", failure);
          this.completeTurn(runId, "failed", "resource_limit");
          throw failure;
        }
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
        this.completeTurn(
          runId,
          "failed",
          error instanceof RunFailure && error.code.endsWith("_LIMIT") ? "resource_limit" : undefined,
        );
        // 模型流无法继续时才提升为 Turn 级失败；具体错误文本保持不变。
        throw toRunFailure(error);
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
      }

      if (roundUsage) roundUsages.push({ round, ...roundUsage });

      this.observations.emit({
        type: "model_round_completed",
        runId,
        roundId,
        completedAt: Date.now(),
        stopReason: reason,
        output: {
          text: payloadEvidence(content),
          ...(thinking ? { thinking: payloadEvidence(thinking) } : {}),
        },
      });
      const modelCalls = [...calls.values()].toSorted(compareToolCallOrder);
      const roundToolArgumentBytes = modelCalls.reduce(
        /** 把当前元素归并到有限累加状态，避免额外复制完整集合。 */
(total, call) => total + jsonBytes(call.arguments, "模型工具参数无法序列化"),
        0,
      );
      turnToolCallCount += modelCalls.length;
      turnToolArgumentBytes += roundToolArgumentBytes;
      if (turnToolCallCount > this.executionBudget.maxToolCallsPerTurn) {
        const failure = new RunFailure(
          `当前 Turn 的工具调用累计超过 ${this.executionBudget.maxToolCallsPerTurn} 个`,
          "TOOL_CALL_TURN_LIMIT",
          false,
        );
        this.runtimeError(runId, "turn", failure);
        this.completeTurn(runId, "failed", "resource_limit");
        throw failure;
      }
      if (turnToolArgumentBytes > this.executionBudget.maxToolArgumentBytesPerTurn) {
        const failure = new RunFailure(
          `当前 Turn 的工具参数累计超过 ${this.executionBudget.maxToolArgumentBytesPerTurn} 字节`,
          "TOOL_ARGUMENT_TURN_BYTES_LIMIT",
          false,
        );
        this.runtimeError(runId, "turn", failure);
        this.completeTurn(runId, "failed", "resource_limit");
        throw failure;
      }
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

      const prepared = modelCalls.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(call, index) =>
        ({ modelCall: call, call: prepareToolCall(currentTools.registry, call, `${randomUUID()}:${index}`) }),
      );
      const assistantMessage = {
        role: "assistant",
        content,
        ...(thinking ? { thinking } : {}),
        toolCalls: prepared.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
({ modelCall, call }) => ({
          id: call.id,
          name: modelCall.name,
          arguments: modelCall.arguments,
        })),
        ...(providerOpaqueContinuation
          ? { providerOpaqueContinuation: structuredClone(providerOpaqueContinuation) }
          : {}),
      } satisfies ModelMessage;
      messages.push(assistantMessage);
      modelInputMessageTraces.push(traceModelInputMessage(
        assistantMessage,
        "current_turn",
        `round:${round}:assistant`,
      ));

      let batch;
      try {
        await observed.phase("tool_execution");
        batch = await currentTools.executeBatch(
          prepared.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.call),
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
        const toolResultMessage = {
          role: "tool",
          toolName: item.call.name,
          toolCallId: item.call.id,
          content: outcome.modelContent,
        } satisfies ToolResultMessage;
        messages.push(toolResultMessage);
        modelInputMessageTraces.push(traceModelInputMessage(toolResultMessage, "tool_result", item.call.id));
        outcome.effects?.fileRelativePaths?.forEach(/** 只汇总工具明确声明的文件副作用，不扫描工作区猜测变化。 */
(path) => fileRelativePaths.add(path));
      }
      if (input.scope && this.resolver && batch.outcomes.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.effects?.capabilitiesChanged)) {
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

  /** 执行「runtimeError」主流程，传播取消与失败并在结束时清理临时资源。 */
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

  /** 只发出有限终态观察事件；Session 持久化和 ACP 投影由各自观察者负责。 */
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

/** 同步裁剪模型消息及其平行 Trace，保持两个数组索引一一对应并累计截断来源。 */
function applyMessageBudget(built: ContextBuildResult, maxMessages: number): void {
  const budgeted = rebudgetContextMessages(
    built.messages,
    built.messageTraces,
    maxMessages,
  );
  built.messages.splice(0, built.messages.length, ...budgeted.messages);
  built.messageTraces.splice(0, built.messageTraces.length, ...budgeted.messageTraces);
  built.truncatedSourceIds.splice(
    0,
    built.truncatedSourceIds.length,
    ...new Set([...built.truncatedSourceIds, ...budgeted.truncatedSourceIds]),
  );
}

/** 汇总「mergeUsage」对应指标，保持缺失字段语义且不重复计算同一来源。 */
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

/** 汇总「aggregateUsage」对应指标，保持缺失字段语义且不重复计算同一来源。 */
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

/** 汇总「sumUsageField」对应指标，保持缺失字段语义且不重复计算同一来源。 */
function sumUsageField<K extends keyof ModelUsage>(
  rounds: ModelRoundUsage[],
  key: K,
): Pick<ModelUsage, K> | Record<string, never> {
  const values = rounds.flatMap(/** 执行「values」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(round) =>
    typeof round[key] === "number" ? [round[key] as number] : [],
  );
  return values.length > 0
    ? { [key]: values.reduce(/** 把当前元素归并到有限累加状态，避免额外复制完整集合。 */
(total, value) => total + value, 0) } as Pick<ModelUsage, K>
    : {};
}

class ObservedRunObserver implements RunObserver {
  private roundId = "";

  /** 初始化「ObservedRunObserver」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(
    private readonly delegate: RunObserver,
    private readonly observations: RuntimeObservationSink,
    private readonly runId: string,
  ) {}

  /** 执行「enterRound」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
enterRound(roundId: string): void { this.roundId = roundId; }
  /** 执行「context」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
context(summary: ContextSummary): Promise<void> { return this.delegate.context(summary); }
  /** 执行「phase」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
phase(phase: TurnActivePhase): Promise<void> { return this.delegate.phase?.(phase) ?? Promise.resolve(); }
  /** 生成「turnSnapshot」不可变视图，隔离后续状态修改并只暴露该层需要的事实。 */
turnSnapshot(facts: RuntimeTurnSnapshot): Promise<void> { return this.delegate.turnSnapshot?.(facts) ?? Promise.resolve(); }
  /** 生成「capabilitySnapshot」不可变视图，隔离后续状态修改并只暴露该层需要的事实。 */
capabilitySnapshot(generation: number, hash: string, snapshot: RuntimeCapabilitySnapshot): Promise<void> { return this.delegate.capabilitySnapshot?.(generation, hash, snapshot) ?? Promise.resolve(); }
  /** 执行「modelRoundStarted」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
modelRoundStarted(facts: RuntimeModelRoundSnapshot): Promise<void> { return this.delegate.modelRoundStarted?.(facts) ?? Promise.resolve(); }
  /** 执行「modelRoundCompleted」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
modelRoundCompleted(round: number, completedAt: string): Promise<void> { return this.delegate.modelRoundCompleted?.(round, completedAt) ?? Promise.resolve(); }
  /** 执行「text」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
text(round: number, value: string): Promise<void> { return this.delegate.text(round, value); }
  /** 执行「thought」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
thought(round: number, value: string): Promise<void> { return this.delegate.thought(round, value); }
  /** 执行「roundComplete」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
roundComplete(round: number): Promise<void> { return this.delegate.roundComplete(round); }
  /** 执行「providerContinuation」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
providerContinuation(
    round: number,
    continuation: ProviderOpaqueContinuation,
    calls: ModelToolCall[],
  ): Promise<void> {
    return this.delegate.providerContinuation?.(round, continuation, calls) ?? Promise.resolve();
  }

  /** 根据已校验输入构建「toolStart」结果，不额外持有调用方的大对象。 */
async toolStart(call: PreparedToolCall): Promise<void> {
    this.observations.emit({
      type: "tool_call_started",
      runId: this.runId,
      roundId: this.roundId,
      toolCallId: call.id,
      name: call.name,
      arguments: payloadEvidence(call.arguments),
      signatureHash: createHash("sha256").update(call.dedupeKey).digest("hex"),
      permission: call.permission,
      startedAt: Date.now(),
    });
    await this.delegate.toolStart(call);
  }

  /** 根据已校验输入构建「toolFinish」结果，不额外持有调用方的大对象。 */
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
      output: payloadEvidence(result.rawOutput),
    });
    await this.delegate.toolFinish(call, status, result);
  }

  /** 执行「requestPermission」主流程，传播取消与失败并在结束时清理临时资源。 */
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

  /** 执行「askUser」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async askUser(question: string, toolCallId: string): Promise<string> {
    return this.delegate.askUser(question, toolCallId);
  }
}

/** 生成「variantSnapshot」不可变视图，隔离后续状态修改并只暴露该层需要的事实。 */
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

/** 根据已校验输入构建「buildContextSummary」结果，不额外持有调用方的大对象。 */
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
      detail: tools.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(tool) => tool.function.name).join("、"),
      itemCount: tools.length,
      estimatedTokens: estimateTokens(JSON.stringify(tools)),
      trust: "trusted",
      raw: model.serializeContext({ kind: "tools", tools }),
    });
  }

  for (const segment of built.segments) {
    const messages = contextMessages(built, /** 执行「messages」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(item) =>
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

  const history = built.messageTraces.filter(
    /** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.source === "session_history" || item.source === "tool_result",
  );
  if (history.length > 0) {
    const toolResults = history.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.source === "tool_result").length;
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
      estimatedTokens: history.reduce(/** 把当前元素归并到有限累加状态，避免额外复制完整集合。 */
(total, item) => total + item.estimatedTokens, 0),
      trust: "trusted",
      raw: model.serializeContext({
        kind: "messages",
        messages: contextMessages(
          built,
          /** 执行「messages」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
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
      /** 把当前元素归并到有限累加状态，避免额外复制完整集合。 */
(total, item) => total + item.estimatedTokens,
      0,
    ),
  };
}

/** 执行「contextMessages」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function contextMessages(
  built: ContextBuildResult,
  select: (item: ContextBuildResult["messageTraces"][number]) => boolean,
) {
  return built.messages.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(_message, index) => {
    const item = built.messageTraces[index];
    return item !== undefined && select(item);
  });
}

/** 执行「serializeModelInput」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
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
      reasoning: input.reasoning === undefined ? null : input.reasoning,
    }, null, 2),
  };
}

/** 执行「estimateTokens」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

/** 根据已校验输入构建「toolCallKey」结果，不额外持有调用方的大对象。 */
function toolCallKey(call: ModelToolCall): string {
  if (call.id) return call.id;
  if (call.index !== undefined) return `index:${call.index}`;
  return `${call.name}:${JSON.stringify(call.arguments)}`;
}

/** 执行「compareToolCallOrder」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
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

/** 把完整模型轮归类为终答、工具批次、截断、取消或非法输出，供 Runtime 选择唯一分支。 */
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

/** 根据已校验输入构建「buildRuntimeSystemPrompt」结果，不额外持有调用方的大对象。 */
export function buildRuntimeSystemPrompt(systemPrompt: string): string {
  const prompt = systemPrompt.trimEnd();
  const contracts = [
    MODEL_OUTPUT_CONTRACT,
    FILE_ARTIFACT_DELIVERY_CONTRACT,
    ARTIFACT_MENTION_CONTRACT,
    skillUseProtocol(configuredSkillContextVersion()),
  ].join("\n\n");
  return prompt ? `${prompt}\n\n${contracts}` : contracts;
}

/** 在 Runtime 组合边界拒绝零值、负值和非整数预算，避免运行中出现失效上限。 */
function validateExecutionBudget(budget: RuntimeExecutionBudget): void {
  for (const [name, value] of Object.entries(budget)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`Runtime 执行预算 ${name} 必须是正数`);
    }
  }
  for (const name of [
    "maxModelRounds",
    "maxToolCallsPerRound",
    "maxToolCallsPerTurn",
    "maxTextBytesPerRound",
    "maxThinkingBytesPerRound",
    "maxToolArgumentBytesPerCall",
    "maxToolArgumentBytesPerTurn",
    "modelStreamIdleTimeoutMs",
    "maxConcurrentTurns",
  ] as const) {
    if (!Number.isInteger(budget[name])) {
      throw new Error(`Runtime 执行预算 ${name} 必须是整数`);
    }
  }
}

/** 只在资源计数边界序列化一次，并把循环引用等非法 Provider 数据转成结构化失败。 */
function jsonBytes(value: unknown, message: string): number {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch (error) {
    throw new RunFailure(message, "TOOL_ARGUMENT_SERIALIZATION_FAILED", false, { cause: error });
  }
}

/** 把可能很大的运行正文转换为 Trace 可用的固定大小证据。 */
function payloadEvidence(value: unknown): RuntimePayloadEvidence {
  const serialized = typeof value === "string" ? value : JSON.stringify(value) ?? "null";
  return {
    sha256: createHash("sha256").update(serialized).digest("hex"),
    bytes: Buffer.byteLength(serialized),
  };
}

/** 把未知异常转换为「errorText」文本，避免错误序列化过程再次抛出。 */
function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/** 判断「isAbort」对应条件，只返回判定结果且不修改输入状态。 */
function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
