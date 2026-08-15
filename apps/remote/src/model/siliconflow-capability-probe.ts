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
 * Bounded active probe for SiliconFlow's Chat Completions endpoint.
 * Toggle support is declared only when false and true both complete and the
 * wire output observably changes from no reasoning_content to reasoning_content.
 */
export class SiliconFlowCapabilityProber {
  private readonly timeoutMs: number;
  private readonly maxOutputTokens: number;
  private readonly endpointGuard?: SiliconFlowCapabilityProberOptions["endpointGuard"];
  private readonly endpointResolver?: SiliconFlowCapabilityProberOptions["endpointResolver"];
  private readonly now: () => Date;

  constructor(options: SiliconFlowCapabilityProberOptions = {}) {
    this.timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.maxOutputTokens = positiveInteger(
      options.maxOutputTokens,
      DEFAULT_MAX_OUTPUT_TOKENS,
      "maxOutputTokens",
    );
    this.endpointGuard = options.endpointGuard;
    this.endpointResolver = options.endpointResolver;
    this.now = options.now ?? (() => new Date());
  }

  async probe(
    candidate: ResolvedModelStudentCandidate,
  ): Promise<ProviderCapabilitySnapshot> {
    if (
      candidate.presetId !== "siliconflow"
      || candidate.protocol !== "openai_chat_completions"
    ) {
      throw new Error("SiliconFlowCapabilityProber 只能体检 siliconflow Chat Completions 候选");
    }
    const student = probeStudent(candidate);
    const provider = new ChatCompletionsProvider(student, {
      readBearerToken: () => candidate.apiKey,
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

    // stream_options is OpenAI-compatible but not required by SiliconFlow's base
    // streaming contract, so test it independently instead of breaking admission.
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
      thought: runs.some((item) => item.thought.length > 0),
      reasoning,
      testedAt: this.now().toISOString(),
    };
  }

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

  private async run(
    provider: ChatCompletionsProvider,
    input: ModelInput,
    options: ChatCompletionsProbeStreamOptions,
  ): Promise<ProbeRunResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
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

function completedText(result: ProbeRunResult | undefined): result is ProbeRunResult {
  return result !== undefined
    && result.finishReason !== undefined
    && result.finishReason !== "cancelled"
    && result.text.length > 0;
}

function textInput(): ModelInput {
  return {
    systemPrompt: "You are performing a bounded API compatibility probe.",
    messages: [{ role: "user", content: "Reply with exactly MK_TEXT_OK." }],
    tools: [],
  };
}

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

function positiveInteger(value: number | undefined, fallback: number, field: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1) throw new Error(`${field} 必须是正整数`);
  return result;
}
