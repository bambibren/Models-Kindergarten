import { createHash } from "node:crypto";
import {
  readResponsesCapabilityProbe,
  type ConcreteReasoningProfile,
  type ResponsesCapabilityProbe,
  type ResponsesModelCandidateInput,
} from "@kindergarten/contracts";
import { ModelProviderError } from "./model-error.js";
import type {
  ModelEvent,
  ModelInput,
  ModelStudent,
  ModelToolCall,
} from "./model-provider.js";
import type { ProviderOpaqueContinuation } from "./provider-continuation.js";
import type { HttpEndpointResolver } from "./pinned-http-transport.js";
import {
  ResponsesApiProvider,
  type ResponsesProbeStreamOptions,
  type ResponsesReasoningConfiguration,
} from "./responses-api-provider.js";

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 256;
const PROBE_NONCE = "mk-probe-nonce";

const PROFILE_EFFORTS = [
  { profile: "fast", effort: "low" },
  { profile: "balanced", effort: "medium" },
  { profile: "deep", effort: "high" },
  { profile: "max", effort: "xhigh" },
] as const satisfies ReadonlyArray<{
  profile: ConcreteReasoningProfile;
  effort: string;
}>;

/** 描述「ResponsesCapabilityProberOptions」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ResponsesCapabilityProberOptions {
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
  continuation?: ProviderOpaqueContinuation;
  usage: boolean;
  finishReason?: "stop" | "length" | "cancelled";
  effectiveReasoningEffort?: string;
}

/**
 * 对用户给出的确切 Responses endpoint 做有界实测。候选 effort 是协议级枚举，
 * 最终能力只来自目标端点成功完成的请求，不读取域名或模型名称 preset。
 */
export class ResponsesCapabilityProber {
  private readonly timeoutMs: number;
  private readonly maxOutputTokens: number;
  private readonly endpointGuard?: ResponsesCapabilityProberOptions["endpointGuard"];
  private readonly endpointResolver?: ResponsesCapabilityProberOptions["endpointResolver"];
  private readonly now: () => Date;

  /** 初始化「ResponsesCapabilityProber」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(options: ResponsesCapabilityProberOptions = {}) {
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
async probe(candidate: ResponsesModelCandidateInput): Promise<ResponsesCapabilityProbe> {
    const student = probeStudent(candidate);
    const provider = new ResponsesApiProvider(student, {
      readBearerToken: /** 读取「readBearerToken」所需数据，并遵守作用域、分页与容量边界。 */
() => candidate.apiKey,
      reasoning: probeReasoningConfiguration(),
      ...(this.endpointGuard ? { endpointGuard: this.endpointGuard } : {}),
      ...(this.endpointResolver ? { endpointResolver: this.endpointResolver } : {}),
      maxRedirects: 0,
    });

    const baseline = await this.run(provider, textInput(), {});
    if (!baseline.text || baseline.finishReason === "cancelled") {
      throw new ModelProviderError(
        "invalid_model_response",
        "Responses 入园体检没有得到完整文本流",
        false,
      );
    }

    let thought = baseline.thought.length > 0;
    let usage = baseline.usage;
    const accepted = new Map<ConcreteReasoningProfile, string>();
    for (const candidateEffort of PROFILE_EFFORTS) {
      try {
        const run = await this.run(
          provider,
          textInput(reasoningSnapshot(student, candidateEffort.profile, candidateEffort.effort)),
          {},
        );
        // 极高 effort 可能在小输出上限内只返回正式 incomplete 而没有可见文本；
        // baseline 已独立证明文本能力，这里只要求该档位确实进入正式终态。
        if (run.finishReason === undefined || run.finishReason === "cancelled") continue;
        if (
          run.effectiveReasoningEffort !== undefined
          && run.effectiveReasoningEffort !== candidateEffort.effort
        ) {
          continue;
        }
        accepted.set(candidateEffort.profile, candidateEffort.effort);
        thought ||= run.thought.length > 0;
        usage ||= run.usage;
      } catch {
        // 一档失败只表示该档位未获实测确认；不重试，也不阻止其他档位体检。
      }
    }
    if (accepted.size === 0) {
      throw new ModelProviderError(
        "model_request_failed",
        "Responses endpoint 未通过 low/medium/high/xhigh 任一推理档位体检",
        false,
      );
    }

    let toolCalls = false;
    let toolContinuation = false;
    const toolProfile = preferredToolProfile(accepted);
    const toolReasoning = reasoningSnapshot(student, toolProfile, accepted.get(toolProfile)!);
    try {
      const first = await this.run(provider, toolInput(toolReasoning), {
        toolChoice: { type: "function", name: "mk_capability_probe" },
      });
      thought ||= first.thought.length > 0;
      usage ||= first.usage;
      const call = validProbeCall(first.calls);
      if (call && first.continuation && first.finishReason !== "cancelled") {
        toolCalls = true;
        const second = await this.run(
          provider,
          toolContinuationInput(toolReasoning, first.continuation, call),
          { toolChoice: "none" },
        );
        thought ||= second.thought.length > 0;
        usage ||= second.usage;
        toolContinuation = Boolean(second.text) && second.finishReason !== "cancelled";
      }
    } catch {
      // Tool 是独立能力。文本与 reasoning 已通过时，失败投影为 false 而不是伪造 ready。
    }

    const profiles = PROFILE_EFFORTS
      .filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => accepted.has(item.profile))
      .map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.profile);
    const efforts = Object.fromEntries(
      profiles.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(profile) => [profile, accepted.get(profile)!]),
    ) as Partial<Record<ConcreteReasoningProfile, string>>;
    const acceptedEfforts = profiles.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(profile) => efforts[profile]!);
    const defaultProfile = preferredDefaultProfile(profiles);
    return readResponsesCapabilityProbe({
      schemaVersion: 1,
      protocol: "openai_responses",
      adapterRevision: "openai-responses-v1",
      probeVersion: 1,
      // Registry 会在公开或持久化前替换为包含 preset 的规范哈希。
      connectionFingerprint: createHash("sha256")
        .update(["custom_responses", "openai_responses", candidate.baseUrl, candidate.model].join("\u0000"))
        .digest("hex"),
      streaming: true,
      text: true,
      toolCalls,
      toolContinuation,
      usage,
      thought,
      reasoning: {
        capability: {
          schemaVersion: 1,
          control: profiles.length === 1 ? "fixed" : "effort_levels",
          adjustable: profiles.length > 1,
          supportedProfiles: profiles,
          defaultProfile,
          native: { parameter: "reasoning.effort", values: acceptedEfforts },
        },
        nativeByProfile: Object.fromEntries(
          profiles.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(profile) => [profile, { effort: efforts[profile]! }]),
        ),
        acceptedNativeValues: acceptedEfforts.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(effort) => ({ effort })),
      },
      testedAt: this.now().toISOString(),
    });
  }

  /** 执行「run」主流程，传播取消与失败并在结束时清理临时资源。 */
private async run(
    provider: ResponsesApiProvider,
    input: ModelInput,
    options: Omit<ResponsesProbeStreamOptions, "maxOutputTokens" | "onTerminalResponse">,
  ): Promise<ProbeRunResult> {
    const controller = new AbortController();
    const timeout = setTimeout(/** 执行受生命周期约束的定时任务，调用方负责在结束时取消句柄。 */
() => controller.abort(), this.timeoutMs);
    const result: ProbeRunResult = { text: "", thought: "", calls: [], usage: false };
    try {
      for await (const event of provider.streamProbe(input, controller.signal, {
        ...options,
        maxOutputTokens: this.maxOutputTokens,
        onTerminalResponse: /** 处理「onTerminalResponse」事件，校验归属后再推进状态且避免重复提交。 */
(response) => {
          const effort = effectiveReasoningEffort(response);
          if (effort !== undefined) result.effectiveReasoningEffort = effort;
        },
      })) {
        collect(result, event);
      }
      return result;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ModelProviderError(
          "dependency_unavailable",
          `Responses 入园体检超时 (${this.timeoutMs}ms)`,
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
  if (event.type === "provider_continuation") result.continuation = event.continuation;
  if (event.type === "usage") result.usage = true;
  if (event.type === "finish") result.finishReason = event.reason;
}

/** 执行「textInput」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function textInput(reasoning?: ModelInput["reasoning"]): ModelInput {
  return {
    systemPrompt: "You are performing a bounded API compatibility probe.",
    messages: [{ role: "user", content: "Reply with exactly MK_TEXT_OK." }],
    tools: [],
    ...(reasoning ? { reasoning } : {}),
  };
}

/** 根据已校验输入构建「toolInput」结果，不额外持有调用方的大对象。 */
function toolInput(reasoning: ModelInput["reasoning"]): ModelInput {
  return {
    systemPrompt: "You are performing a bounded API compatibility probe.",
    messages: [{
      role: "user",
      content: `Call mk_capability_probe once with nonce ${PROBE_NONCE}. Do not answer directly.`,
    }],
    tools: [probeTool()],
    ...(reasoning ? { reasoning } : {}),
  };
}

/** 根据已校验输入构建「toolContinuationInput」结果，不额外持有调用方的大对象。 */
function toolContinuationInput(
  reasoning: ModelInput["reasoning"],
  continuation: ProviderOpaqueContinuation,
  call: ModelToolCall & { id: string },
): ModelInput {
  return {
    systemPrompt: "You are performing a bounded API compatibility probe.",
    messages: [
      {
        role: "user",
        content: `Call mk_capability_probe once with nonce ${PROBE_NONCE}. Do not answer directly.`,
      },
      { role: "assistant", content: "", providerOpaqueContinuation: continuation },
      {
        role: "tool",
        content: JSON.stringify({ ok: true, nonce: PROBE_NONCE }),
        toolName: "mk_capability_probe",
        toolCallId: call.id,
      },
    ],
    tools: [probeTool()],
    ...(reasoning ? { reasoning } : {}),
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
function validProbeCall(calls: ModelToolCall[]): (ModelToolCall & { id: string }) | undefined {
  if (calls.length !== 1) return undefined;
  const call = calls[0];
  if (
    !call?.id
    || call.name !== "mk_capability_probe"
    || call.arguments.nonce !== PROBE_NONCE
  ) {
    return undefined;
  }
  return call as ModelToolCall & { id: string };
}

/** 生成「reasoningSnapshot」不可变视图，隔离后续状态修改并只暴露该层需要的事实。 */
function reasoningSnapshot(
  student: ModelStudent,
  profile: ConcreteReasoningProfile,
  effort: string,
): Exclude<ModelInput["reasoning"], "disabled" | undefined> {
  return {
    schemaVersion: 1,
    requestedProfile: profile,
    resolvedProfile: profile,
    source: "model_default",
    providerKind: student.provider.kind,
    model: student.provider.model,
    native: { effort },
  };
}

/** 执行「probeStudent」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function probeStudent(candidate: ResponsesModelCandidateInput): ModelStudent {
  return {
    id: "responses-admission-probe",
    name: candidate.displayName,
    sizeClass: "large",
    provider: {
      kind: "openai-compatible",
      baseUrl: candidate.baseUrl,
      model: candidate.model,
    },
    generationDefaults: {},
  };
}

/** 执行「probeReasoningConfiguration」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function probeReasoningConfiguration(): ResponsesReasoningConfiguration {
  return {
    capability: {
      schemaVersion: 1,
      control: "effort_levels",
      adjustable: true,
      supportedProfiles: PROFILE_EFFORTS.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.profile),
      defaultProfile: "balanced",
      native: {
        parameter: "reasoning.effort",
        values: PROFILE_EFFORTS.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.effort),
      },
    },
    efforts: Object.fromEntries(
      PROFILE_EFFORTS.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => [item.profile, item.effort]),
    ),
  };
}

/** 执行「effectiveReasoningEffort」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function effectiveReasoningEffort(response: Readonly<Record<string, unknown>>): string | undefined {
  if (typeof response.reasoning_effort === "string") return response.reasoning_effort;
  const reasoning = response.reasoning;
  if (typeof reasoning !== "object" || reasoning === null || Array.isArray(reasoning)) return undefined;
  const effort = (reasoning as Record<string, unknown>).effort;
  return typeof effort === "string" ? effort : undefined;
}

/** 执行「preferredDefaultProfile」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function preferredDefaultProfile(
  profiles: readonly ConcreteReasoningProfile[],
): ConcreteReasoningProfile {
  if (profiles.includes("balanced")) return "balanced";
  if (profiles.includes("deep")) return "deep";
  const first = profiles[0];
  if (!first) throw new Error("Responses reasoning profile 不能为空");
  return first;
}

/** 执行「preferredToolProfile」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function preferredToolProfile(
  accepted: ReadonlyMap<ConcreteReasoningProfile, string>,
): ConcreteReasoningProfile {
  for (const profile of ["balanced", "fast", "deep", "max"] as const) {
    if (accepted.has(profile)) return profile;
  }
  throw new Error("Responses reasoning profile 不能为空");
}

/** 执行「positiveInteger」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function positiveInteger(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${field} 必须是正整数`);
  return value;
}
