import { createHash } from "node:crypto";
import type {
  ConcreteReasoningProfile,
  ProviderCapabilitySnapshot,
  ResolvedModelStudentCandidate,
} from "@kindergarten/contracts";
import { ModelProviderError } from "./model-error.js";
import type {
  ModelEvent,
  ModelInput,
  ModelStudent,
  ModelToolCall,
} from "./model-provider.js";
import type { HttpEndpointResolver } from "./pinned-http-transport.js";
import {
  ChatCompletionsProvider,
  type ChatCompletionsNativeReasoning,
  type ChatCompletionsProbeStreamOptions,
  type ChatCompletionsReasoningConfiguration,
} from "./chat-completions-provider.js";

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 256;
const PROBE_NONCE = "mk-siliconflow-probe-nonce";
const ADAPTER_REVISION = "siliconflow-chat-completions-v1";
const PROBE_VERSION = 1;

/** 描述「SiliconFlowCapabilityProberOptions」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface SiliconFlowCapabilityProberOptions {
  timeoutMs?: number;
  maxOutputTokens?: number;
  endpointGuard?: (url: URL) => void | Promise<void>;
  endpointResolver?: HttpEndpointResolver;
  now?: () => Date;
}

interface ProbeRunResult {
  text: string;
  thought: string;
  calls: ModelToolCall[];
  usage: boolean;
  reasoningOutputTokens?: number;
  finishReason?: "stop" | "length" | "cancelled";
}

/**
 * 对硅基流动 Chat Completions 端点执行有界主动探针。
 * 只有 false/true 两次请求都完成，且 wire 输出从无 `reasoning_content` 明确变为有该字段，
 * 才声明端点支持 reasoning 开关。
 */
/** 描述「SiliconFlowCapabilityProber」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export class SiliconFlowCapabilityProber {
  private readonly timeoutMs: number;
  private readonly maxOutputTokens: number;
  private readonly endpointGuard?: SiliconFlowCapabilityProberOptions["endpointGuard"];
  private readonly endpointResolver?: SiliconFlowCapabilityProberOptions["endpointResolver"];
  private readonly now: () => Date;

  /** 初始化「SiliconFlowCapabilityProber」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(options: SiliconFlowCapabilityProberOptions = {}) {
    this.timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.maxOutputTokens = positiveInteger(
      options.maxOutputTokens,
      DEFAULT_MAX_OUTPUT_TOKENS,
      "maxOutputTokens",
    );
    this.endpointGuard = options.endpointGuard;
    this.endpointResolver = options.endpointResolver;
    this.now = options.now ?? (/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
() => new Date());
  }

  /** 执行「probe」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async probe(
    candidate: ResolvedModelStudentCandidate,
  ): Promise<ProviderCapabilitySnapshot> {
    if (
      candidate.presetId !== "siliconflow"
      || candidate.protocol !== "openai_chat_completions"
    ) {
      throw new Error("SiliconFlowCapabilityProber 只能体检 siliconflow Chat Completions 候选");
    }
    const apiKey = candidate.apiKey;
    if (!apiKey) throw new Error("SiliconFlow 候选缺少 API Key");
    const student = probeStudent(candidate);
    const provider = new ChatCompletionsProvider(student, {
      readBearerToken: /** 读取「readBearerToken」所需数据，并遵守作用域、分页与容量边界。 */
() => apiKey,
      reasoning: fixedReasoningConfiguration(),
      ...(this.endpointGuard ? { endpointGuard: this.endpointGuard } : {}),
      ...(this.endpointResolver ? { endpointResolver: this.endpointResolver } : {}),
      maxRedirects: 0,
    });

    const baseline = await this.run(provider, textInput(), {});
    if (!baseline.text || baseline.finishReason === "cancelled") {
      throw new ModelProviderError(
        "invalid_model_response",
        "SiliconFlow 入园体检没有得到完整文本流",
        false,
      );
    }

    // `stream_options` 与 OpenAI 兼容，但不是硅基流动基础流协议的必需项；单独探测，失败不应破坏基础入园。
    const usageRun = await this.tryRun(provider, textInput(), { includeUsage: true });

    const thinkingOffNative = { enable_thinking: false } as const;
    const thinkingOnNative = { enable_thinking: true } as const;
    const thinkingOff = await this.tryRun(
      provider,
      reasoningInput(),
      {
        nativeReasoning: thinkingOffNative,
        ...(usageRun?.usage ? { includeUsage: true } : {}),
      },
    );
    const thinkingOn = await this.tryRun(
      provider,
      reasoningInput(),
      {
        nativeReasoning: thinkingOnNative,
        ...(usageRun?.usage ? { includeUsage: true } : {}),
      },
    );
    const toggleObserved = completedText(thinkingOff)
      && completedText(thinkingOn)
      && (
        thinkingOff.thought.length === 0 && thinkingOn.thought.length > 0
        || (thinkingOff.reasoningOutputTokens ?? 0) === 0
          && (thinkingOn.reasoningOutputTokens ?? 0) > 0
      );

    const reasoning = toggleObserved
      ? toggleReasoningSnapshot()
      : fixedReasoningSnapshot();
    const defaultNative = reasoning.nativeByProfile[
      reasoning.capability.defaultProfile
    ] ?? {};

    let toolCalls = false;
    let toolContinuation = false;
    const toolRound = await this.tryRun(provider, toolInput(), {
      nativeReasoning: defaultNative,
    });
    const call = toolRound ? validProbeCall(toolRound.calls) : undefined;
    if (call) {
      toolCalls = true;
      const continuation = await this.tryRun(
        provider,
        toolContinuationInput(call),
        { nativeReasoning: defaultNative },
      );
      toolContinuation = completedText(continuation);
    }

    const runs = [baseline, usageRun, thinkingOff, thinkingOn, toolRound].filter(
      /** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item): item is ProbeRunResult => item !== undefined,
    );
    return {
      schemaVersion: 1,
      protocol: "openai_chat_completions",
      adapterRevision: ADAPTER_REVISION,
      probeVersion: PROBE_VERSION,
      connectionFingerprint: connectionFingerprint(candidate),
      streaming: true,
      text: true,
      toolCalls,
      toolContinuation,
      usage: usageRun?.usage === true,
      thought: runs.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.thought.length > 0),
      reasoning,
      testedAt: this.now().toISOString(),
    };
  }

  /** 执行「tryRun」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
private async tryRun(
    provider: ChatCompletionsProvider,
    input: ModelInput,
    options: ChatCompletionsProbeStreamOptions,
  ): Promise<ProbeRunResult | undefined> {
    try {
      return await this.run(provider, input, options);
    } catch (error) {
      if (error instanceof ModelProviderError) return undefined;
      throw error;
    }
  }

  /** 执行「run」主流程，传播取消与失败并在结束时清理临时资源。 */
private async run(
    provider: ChatCompletionsProvider,
    input: ModelInput,
    options: ChatCompletionsProbeStreamOptions,
  ): Promise<ProbeRunResult> {
    const controller = new AbortController();
    const timeout = setTimeout(/** 执行受生命周期约束的定时任务，调用方负责在结束时取消句柄。 */
() => controller.abort(), this.timeoutMs);
    const result: ProbeRunResult = { text: "", thought: "", calls: [], usage: false };
    try {
      for await (const event of provider.streamProbe(input, controller.signal, {
        ...options,
        maxOutputTokens: this.maxOutputTokens,
      })) {
        collect(result, event);
      }
      return result;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ModelProviderError(
          "dependency_unavailable",
          `SiliconFlow 入园体检超时 (${this.timeoutMs}ms)`,
          true,
          { cause: error },
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** 执行「collect」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function collect(result: ProbeRunResult, event: ModelEvent): void {
  if (event.type === "text_delta") result.text += event.text;
  if (event.type === "thinking_delta") result.thought += event.text;
  if (event.type === "tool_calls") result.calls.push(...event.calls);
  if (event.type === "usage") {
    result.usage = true;
    if (event.reasoningOutputTokens !== undefined) {
      result.reasoningOutputTokens = event.reasoningOutputTokens;
    }
  }
  if (event.type === "finish") result.finishReason = event.reason;
}

/** 执行「completedText」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function completedText(result: ProbeRunResult | undefined): result is ProbeRunResult {
  return result !== undefined
    && result.finishReason !== undefined
    && result.finishReason !== "cancelled"
    && result.text.length > 0;
}

/** 执行「textInput」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function textInput(): ModelInput {
  return {
    systemPrompt: "You are performing a bounded API compatibility probe.",
    messages: [{ role: "user", content: "Reply with exactly MK_TEXT_OK." }],
    tools: [],
  };
}

/** 执行「reasoningInput」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function reasoningInput(): ModelInput {
  return {
    systemPrompt: "You are performing a bounded API compatibility probe.",
    messages: [{
      role: "user",
      content: "Reason briefly about 17 + 25, then end your answer with MK_REASON_OK.",
    }],
    tools: [],
  };
}

/** 根据已校验输入构建「toolInput」结果，不额外持有调用方的大对象。 */
function toolInput(): ModelInput {
  return {
    systemPrompt: "You are performing a bounded API compatibility probe.",
    messages: [{
      role: "user",
      content: `Call mk_capability_probe exactly once with nonce ${PROBE_NONCE}. Do not answer directly.`,
    }],
    tools: [probeTool()],
  };
}

/** 根据已校验输入构建「toolContinuationInput」结果，不额外持有调用方的大对象。 */
function toolContinuationInput(call: ModelToolCall & { id: string }): ModelInput {
  return {
    systemPrompt: "You are performing a bounded API compatibility probe.",
    messages: [
      {
        role: "user",
        content: `Call mk_capability_probe exactly once with nonce ${PROBE_NONCE}. Do not answer directly.`,
      },
      {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: call.id,
          name: call.name,
          arguments: structuredClone(call.arguments),
        }],
      },
      {
        role: "tool",
        content: JSON.stringify({ ok: true, nonce: PROBE_NONCE }),
        toolName: "mk_capability_probe",
        toolCallId: call.id,
      },
    ],
    tools: [probeTool()],
  };
}

/** 执行「probeTool」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function probeTool(): ModelInput["tools"][number] {
  return {
    type: "function",
    function: {
      name: "mk_capability_probe",
      description: "A no-side-effect compatibility probe. Returns the supplied nonce.",
      parameters: {
        type: "object",
        properties: { nonce: { type: "string", const: PROBE_NONCE } },
        required: ["nonce"],
        additionalProperties: false,
      },
    },
  };
}

/** 执行「validProbeCall」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function validProbeCall(
  calls: ModelToolCall[],
): (ModelToolCall & { id: string }) | undefined {
  if (calls.length !== 1) return undefined;
  const call = calls[0];
  if (
    !call?.id
    || call.name !== "mk_capability_probe"
    || call.arguments.nonce !== PROBE_NONCE
  ) return undefined;
  return call as ModelToolCall & { id: string };
}

/** 执行「fixedReasoningConfiguration」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function fixedReasoningConfiguration(): ChatCompletionsReasoningConfiguration {
  return {
    capability: {
      schemaVersion: 1,
      control: "fixed",
      adjustable: false,
      supportedProfiles: ["balanced"],
      defaultProfile: "balanced",
    },
    nativeByProfile: { balanced: {} },
  };
}

/** 生成「fixedReasoningSnapshot」不可变视图，隔离后续状态修改并只暴露该层需要的事实。 */
function fixedReasoningSnapshot(): ProviderCapabilitySnapshot["reasoning"] {
  return {
    capability: {
      schemaVersion: 1,
      control: "fixed",
      adjustable: false,
      supportedProfiles: ["balanced"],
      defaultProfile: "balanced",
    },
    nativeByProfile: { balanced: {} },
    acceptedNativeValues: [{}],
  };
}

/** 根据已校验输入构建「toggleReasoningSnapshot」结果，不额外持有调用方的大对象。 */
function toggleReasoningSnapshot(): ProviderCapabilitySnapshot["reasoning"] {
  const nativeByProfile: Partial<
    Record<ConcreteReasoningProfile, ChatCompletionsNativeReasoning>
  > = {
    fast: { enable_thinking: false },
    balanced: { enable_thinking: true },
  };
  return {
    capability: {
      schemaVersion: 1,
      control: "toggle",
      adjustable: true,
      supportedProfiles: ["fast", "balanced"],
      defaultProfile: "balanced",
      native: {
        parameter: "enable_thinking",
        values: [false, true],
      },
    },
    nativeByProfile,
    acceptedNativeValues: [
      { enable_thinking: false },
      { enable_thinking: true },
    ],
  };
}

/** 执行「probeStudent」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function probeStudent(candidate: ResolvedModelStudentCandidate): ModelStudent {
  return {
    id: "siliconflow-admission-probe",
    name: candidate.displayName,
    sizeClass: "large",
    provider: {
      kind: "siliconflow",
      baseUrl: candidate.baseUrl,
      model: candidate.model,
    },
    generationDefaults: {},
  };
}

/** 执行「connectionFingerprint」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function connectionFingerprint(
  candidate: Pick<
    ResolvedModelStudentCandidate,
    "presetId" | "protocol" | "baseUrl" | "model"
  >,
): string {
  return createHash("sha256")
    .update([
      candidate.presetId,
      candidate.protocol,
      candidate.baseUrl,
      candidate.model,
    ].join("\u0000"))
    .digest("hex");
}

/** 执行「positiveInteger」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function positiveInteger(value: number | undefined, fallback: number, field: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1) throw new Error(`${field} 必须是正整数`);
  return result;
}
