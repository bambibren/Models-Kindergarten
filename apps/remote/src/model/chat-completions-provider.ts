import {
  readModelReasoningCapability,
  type ConcreteReasoningProfile,
  type ModelReasoningCapability,
} from "@kindergarten/contracts";
import { ModelProviderError } from "./model-error.js";
import type {
  ModelContextFragment,
  ModelContextSerialization,
  ModelEvent,
  ModelInput,
  ModelMessage,
  ModelProvider,
  ModelStudent,
  ModelToolCall,
  ModelToolDefinition,
  ModelUsage,
} from "./model-provider.js";
import {
  GlobalFetchHttpTransport,
  PinnedHttpTransport,
  type HttpEndpointResolver,
  type OutboundHttpTransport,
} from "./pinned-http-transport.js";

/** 描述「ChatCompletionsNativeReasoning」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ChatCompletionsNativeReasoning = Record<
  string,
  string | number | boolean
>;

/** 描述「ChatCompletionsReasoningConfiguration」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ChatCompletionsReasoningConfiguration {
  capability: ModelReasoningCapability;
  nativeByProfile: Partial<
    Record<ConcreteReasoningProfile, ChatCompletionsNativeReasoning>
  >;
}

/** 描述「ChatCompletionsProviderOptions」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ChatCompletionsProviderOptions {
  readBearerToken(): string | Promise<string>;
  /** 必须来自目标端点本身已成功的入园体检，不能按厂商或模型名猜测。 */
  reasoning: ChatCompletionsReasoningConfiguration;
  /** 只有目标端点实际接受并返回 usage 后，才发送 OpenAI `stream_options`。 */
  includeStreamUsage?: boolean;
  endpointGuard?: (url: URL) => void | Promise<void>;
  /** 生产远端必须把已审核地址绑定到 socket lookup，防止 DNS 重绑定。 */
  endpointResolver?: HttpEndpointResolver;
  /** 默认不跟随重定向；显式开启后也只跟随同源 307/308。 */
  maxRedirects?: number;
}

/** 描述「ChatCompletionsProbeStreamOptions」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ChatCompletionsProbeStreamOptions {
  maxOutputTokens?: number;
  toolChoice?: "none" | "auto" | {
    type: "function";
    function: { name: string };
  };
  /** 仅用于入园体检的候选参数；探针成功前不得持久化。 */
  nativeReasoning?: ChatCompletionsNativeReasoning;
  /** 仅供入园独立测试 `stream_options.include_usage`，不与基础流能力捆绑。 */
  includeUsage?: boolean;
}

interface SseEvent {
  event?: string;
  data: string;
}

interface ToolCallState {
  index: number;
  firstSeen: number;
  id?: string;
  nameText: string;
  argumentsText: string;
}

const ALLOWED_REASONING_PARAMETERS = new Set([
  "enable_thinking",
  "reasoning_effort",
  "thinking_budget",
]);
const MAX_SSE_LINE_BYTES = 1024 * 1024;
const MAX_SSE_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_SSE_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_HTTP_ERROR_BODY_BYTES = 64 * 1024;

/**
 * 硅基流动使用的 OpenAI Chat Completions wire Adapter。
 * 能力只来自目标端点探针，不根据厂商或模型名称推断。
 */
/** 描述「ChatCompletionsProvider」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export class ChatCompletionsProvider implements ModelProvider {
  readonly reasoningCapability: ModelReasoningCapability;
  private readonly readBearerToken: ChatCompletionsProviderOptions["readBearerToken"];
  private readonly nativeByProfile: Readonly<
    Partial<Record<ConcreteReasoningProfile, ChatCompletionsNativeReasoning>>
  >;
  private readonly endpointGuard: NonNullable<ChatCompletionsProviderOptions["endpointGuard"]>;
  private readonly httpTransport: OutboundHttpTransport;
  private readonly maxRedirects: number;
  readonly includeStreamUsage: boolean;

  /** 初始化「ChatCompletionsProvider」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(
    readonly student: ModelStudent,
    options: ChatCompletionsProviderOptions,
  ) {
    if (
      student.provider.kind !== "siliconflow"
      && student.provider.kind !== "openai-compatible"
    ) {
      throw new Error(
        "ChatCompletionsProvider 只能接收 siliconflow 或 openai-compatible ModelStudent",
      );
    }
    this.reasoningCapability = readModelReasoningCapability(options.reasoning.capability);
    this.nativeByProfile = validateReasoningConfiguration(
      this.reasoningCapability,
      options.reasoning.nativeByProfile,
    );
    this.readBearerToken = options.readBearerToken;
    this.endpointGuard = options.endpointGuard ?? (/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
() => undefined);
    this.httpTransport = options.endpointResolver
      ? new PinnedHttpTransport(options.endpointResolver)
      : new GlobalFetchHttpTransport();
    this.maxRedirects = readMaxRedirects(options.maxRedirects);
    this.includeStreamUsage = options.includeStreamUsage === true;
  }

  /** 执行「nativeReasoning」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
nativeReasoning(profile: ConcreteReasoningProfile): ChatCompletionsNativeReasoning {
    const native = this.nativeByProfile[profile];
    if (!native) {
      throw new Error(`Chat Completions 模型不支持推理档位: ${profile}`);
    }
    return structuredClone(native);
  }

  /** 执行「serializeContext」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
serializeContext(fragment: ModelContextFragment): ModelContextSerialization {
    let value: unknown;
    switch (fragment.kind) {
      case "system":
        value = toSystemMessage(fragment.content);
        break;
      case "tools":
        value = fragment.tools.map(toChatTool);
        break;
      case "messages":
        value = fragment.messages.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(message) => toChatMessage(this.student, message));
        break;
      case "omitted":
        value = { sent: false, sourceIds: fragment.sourceIds };
        break;
    }
    return {
      provider: this.student.provider.kind,
      model: this.student.provider.model,
      format: "json",
      value: JSON.stringify(value, null, 2),
    };
  }

  /** 执行「serializeInput」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
serializeInput(input: ModelInput): ModelContextSerialization {
    return {
      provider: this.student.provider.kind,
      model: this.student.provider.model,
      format: "json",
      value: JSON.stringify(toChatRequest(this, input, {}), null, 2),
    };
  }

  /** 执行「stream」主流程，传播取消与失败并在结束时清理临时资源。 */
async *stream(
    input: ModelInput,
    signal: AbortSignal,
    onActivity?: () => void,
  ): AsyncIterable<ModelEvent> {
    yield* this.streamRequest(input, signal, {}, onActivity);
  }

  /** 入园探针入口；复用生产序列化器和 SSE Parser，避免体检与运行协议漂移。 */
  /** 执行「streamProbe」主流程，传播取消与失败并在结束时清理临时资源。 */
async *streamProbe(
    input: ModelInput,
    signal: AbortSignal,
    options: ChatCompletionsProbeStreamOptions,
  ): AsyncIterable<ModelEvent> {
    yield* this.streamRequest(input, signal, options);
  }

  /** 执行「streamRequest」主流程，传播取消与失败并在结束时清理临时资源。 */
private async *streamRequest(
    input: ModelInput,
    signal: AbortSignal,
    options: ChatCompletionsProbeStreamOptions,
    onActivity?: () => void,
  ): AsyncIterable<ModelEvent> {
    const token = await this.loadToken();
    let response: Response;
    try {
      response = await this.fetchResponse(
        chatCompletionsApiUrl(this.student.provider.baseUrl),
        JSON.stringify(toChatRequest(this, input, options)),
        token,
        signal,
      );
    } catch (error) {
      if (isAbort(error) || signal.aborted) throw error;
      if (error instanceof ModelProviderError) throw error;
      const detail = error instanceof Error ? redact(error.message, token) : "";
      throw new ModelProviderError(
        "dependency_unavailable",
        `无法连接 Chat Completions API${detail ? `: ${short(detail, 160)}` : ""}`,
        true,
        { cause: error },
      );
    }

    if (!response.ok) {
      const detail = redact(await readErrorBody(response), token);
      throw new ModelProviderError(
        "model_request_failed",
        `Chat Completions API 请求失败 (${response.status})${detail ? `: ${detail}` : ""}`,
        response.status === 429 || response.status >= 500,
      );
    }
    if (!response.body) {
      throw new ModelProviderError(
        "invalid_model_response",
        "Chat Completions API 响应没有流式 Body",
        false,
      );
    }

    const calls = new Map<number, ToolCallState>();
    let firstSeen = 0;
    let finishReason: "stop" | "length" | "cancelled" | undefined;
    let terminal = false;

    for await (const message of readSse(response.body)) {
      onActivity?.();
      if (message.data === "[DONE]") {
        if (finishReason === undefined) {
          throw new ModelProviderError(
            "invalid_model_response",
            "Chat Completions API 在 finish_reason 前发送了 [DONE]",
            false,
          );
        }
        const completedCalls = completeToolCalls(calls);
        if (completedCalls.length > 0) {
          yield { type: "tool_calls", calls: completedCalls };
        }
        terminal = true;
        yield { type: "finish", reason: finishReason };
        break;
      }

      const chunk = parseSseJson(message, token);
      const error = recordValue(chunk.error);
      if (message.event === "error" || error) {
        throw chatError(error ?? chunk, token);
      }

      const usage = readUsage(chunk.usage);
      if (usage) yield { type: "usage", ...usage };

      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      for (const value of choices) {
        const choice = recordValue(value);
        if (!choice || readChoiceIndex(choice) !== 0) continue;
        const delta = recordValue(choice.delta);
        const text = stringValue(delta?.content);
        const thought = stringValue(delta?.reasoning_content);
        if (thought) yield { type: "thinking_delta", text: thought };
        if (text) yield { type: "text_delta", text };

        if (Array.isArray(delta?.tool_calls)) {
          for (const item of delta.tool_calls) {
            const call = recordValue(item);
            if (!call) continue;
            const index = integerValue(call.index);
            if (index === undefined || index < 0) {
              throw new ModelProviderError(
                "invalid_model_response",
                "Chat Completions Tool Call 增量缺少稳定 index",
                false,
              );
            }
            const state = calls.get(index) ?? {
              index,
              firstSeen: firstSeen++,
              nameText: "",
              argumentsText: "",
            };
            mergeToolCallDelta(state, call);
            calls.set(index, state);
          }
        }

        const wireFinishReason = stringValue(choice.finish_reason);
        if (wireFinishReason !== undefined) {
          const next = normalizeFinishReason(wireFinishReason);
          if (finishReason !== undefined && finishReason !== next) {
            throw new ModelProviderError(
              "invalid_model_response",
              "Chat Completions API 返回了冲突的 finish_reason",
              false,
            );
          }
          finishReason = next;
        }
      }
    }

    if (!terminal) {
      throw new ModelProviderError(
        "invalid_model_response",
        "Chat Completions API 流在 [DONE] 前结束",
        false,
      );
    }
  }

  /** 执行「resolvedNativeReasoning」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
resolvedNativeReasoning(
    input: ModelInput,
  ): ChatCompletionsNativeReasoning {
    if (input.reasoning === "disabled") {
      const disabled = this.nativeByProfile.fast;
      return disabled?.enable_thinking === false ? structuredClone(disabled) : {};
    }
    if (input.reasoning === undefined) {
      return this.nativeReasoning(this.reasoningCapability.defaultProfile);
    }
    if (
      input.reasoning.providerKind !== this.student.provider.kind
      || input.reasoning.model !== this.student.provider.model
    ) {
      throw new ModelProviderError(
        "model_request_failed",
        "推理快照与当前 Chat Completions ModelStudent 不匹配",
        false,
      );
    }
    const expected = this.nativeReasoning(input.reasoning.resolvedProfile);
    if (!sameNativeReasoning(expected, input.reasoning.native)) {
      throw new ModelProviderError(
        "model_request_failed",
        "Chat Completions 推理快照与入园能力映射不一致",
        false,
      );
    }
    return expected;
  }

  /** 读取「loadToken」所需数据，并遵守作用域、分页与容量边界。 */
private async loadToken(): Promise<string> {
    let token: string;
    try {
      token = (await this.readBearerToken()).trim();
    } catch (error) {
      throw new ModelProviderError(
        "dependency_unavailable",
        "无法读取 Chat Completions API 凭据",
        false,
        { cause: error },
      );
    }
    if (!token) {
      throw new ModelProviderError(
        "dependency_unavailable",
        "Chat Completions API 凭据为空",
        false,
      );
    }
    return token;
  }

  /** 读取「fetchResponse」所需数据，并遵守作用域、分页与容量边界。 */
private async fetchResponse(
    initialUrl: URL,
    body: string,
    token: string,
    signal: AbortSignal,
  ): Promise<Response> {
    let url = initialUrl;
    for (let redirects = 0; ; redirects += 1) {
      await this.endpointGuard(new URL(url));
      const response = await this.httpTransport.request(url, {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body,
        signal,
      });
      if (!isRedirectStatus(response.status)) return response;
      if ((response.status !== 307 && response.status !== 308) || redirects >= this.maxRedirects) {
        await response.body?.cancel().catch(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => undefined);
        throw new ModelProviderError(
          "model_request_failed",
          `Chat Completions API 返回不允许的重定向 (${response.status})`,
          false,
        );
      }
      const location = response.headers.get("location");
      await response.body?.cancel().catch(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => undefined);
      if (!location) {
        throw new ModelProviderError(
          "invalid_model_response",
          "Chat Completions API 重定向缺少 Location",
          false,
        );
      }
      const next = new URL(location, url);
      if (next.origin !== url.origin) {
        throw new ModelProviderError(
          "model_request_failed",
          "Chat Completions API 不允许携带凭据跨站重定向",
          false,
        );
      }
      url = next;
    }
  }
}

/** 根据已校验输入构建「toChatRequest」结果，不额外持有调用方的大对象。 */
function toChatRequest(
  provider: ChatCompletionsProvider,
  input: ModelInput,
  options: ChatCompletionsProbeStreamOptions,
): Record<string, unknown> {
  const nativeReasoning = options.nativeReasoning === undefined
    ? provider.resolvedNativeReasoning(input)
    : validateNativeReasoning(options.nativeReasoning);
  const messages = [
    toSystemMessage(input.systemPrompt),
    ...input.messages.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(message) => toChatMessage(provider.student, message)),
  ];
  return {
    model: provider.student.provider.model,
    messages,
    ...(input.tools.length > 0 ? { tools: input.tools.map(toChatTool) } : {}),
    stream: true,
    ...(options.includeUsage === true || options.includeUsage === undefined && provider.includeStreamUsage
      ? { stream_options: { include_usage: true } }
      : {}),
    ...nativeReasoning,
    ...(options.maxOutputTokens !== undefined
      ? { max_tokens: readPositiveInteger(options.maxOutputTokens, "maxOutputTokens") }
      : {}),
    ...(options.toolChoice !== undefined
      ? { tool_choice: structuredClone(options.toolChoice) }
      : {}),
    ...(provider.student.generationDefaults.temperature !== undefined
      ? { temperature: provider.student.generationDefaults.temperature }
      : {}),
  };
}

/** 根据已校验输入构建「toSystemMessage」结果，不额外持有调用方的大对象。 */
function toSystemMessage(content: string): Record<string, unknown> {
  return { role: "system", content };
}

/** 根据已校验输入构建「toChatMessage」结果，不额外持有调用方的大对象。 */
function toChatMessage(student: ModelStudent, message: ModelMessage): Record<string, unknown> {
  if (message.providerOpaqueContinuation) {
    throw new ModelProviderError(
      "invalid_model_response",
      `Provider continuation 不能用于 ${student.provider.kind} Chat Completions`,
      false,
    );
  }
  if (message.role === "tool") {
    if (!message.toolCallId) {
      throw new ModelProviderError(
        "invalid_model_response",
        "Chat Completions Tool Result 缺少 toolCallId",
        false,
      );
    }
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
      ...(message.toolName ? { name: message.toolName } : {}),
    };
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content || null,
      ...(message.thinking ? { reasoning_content: message.thinking } : {}),
      tool_calls: message.toolCalls.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(call) => {
        if (!call.id) {
          throw new ModelProviderError(
            "invalid_model_response",
            "Chat Completions Assistant Tool Call 缺少 id",
            false,
          );
        }
        return {
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          },
        };
      }),
    };
  }
  return {
    role: message.role,
    content: message.content,
    ...(message.role === "assistant" && message.thinking
      ? { reasoning_content: message.thinking }
      : {}),
  };
}

/** 根据已校验输入构建「toChatTool」结果，不额外持有调用方的大对象。 */
function toChatTool(tool: ModelToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: structuredClone(tool.function.parameters),
    },
  };
}

/** 校验并规范化「validateReasoningConfiguration」输入，非法数据直接返回明确错误。 */
function validateReasoningConfiguration(
  capability: ModelReasoningCapability,
  nativeByProfile: ChatCompletionsReasoningConfiguration["nativeByProfile"],
): Readonly<Partial<Record<ConcreteReasoningProfile, ChatCompletionsNativeReasoning>>> {
  const result: Partial<Record<ConcreteReasoningProfile, ChatCompletionsNativeReasoning>> = {};
  for (const profile of capability.supportedProfiles) {
    const native = nativeByProfile[profile];
    if (!native) throw new Error(`Chat Completions reasoning 档位 ${profile} 缺少原生映射`);
    result[profile] = validateNativeReasoning(native);
  }
  return Object.freeze(result);
}

/** 校验并规范化「validateNativeReasoning」输入，非法数据直接返回明确错误。 */
function validateNativeReasoning(
  input: ChatCompletionsNativeReasoning,
): ChatCompletionsNativeReasoning {
  const result: ChatCompletionsNativeReasoning = {};
  for (const [key, value] of Object.entries(input)) {
    if (!ALLOWED_REASONING_PARAMETERS.has(key)) {
      throw new Error(`Chat Completions 不支持 reasoning 参数: ${key}`);
    }
    if (key === "enable_thinking" && typeof value !== "boolean") {
      throw new Error("enable_thinking 必须是 boolean");
    }
    if (key === "reasoning_effort" && (typeof value !== "string" || !value)) {
      throw new Error("reasoning_effort 必须是非空字符串");
    }
    if (key === "thinking_budget" && (!Number.isInteger(value) || Number(value) < 1)) {
      throw new Error("thinking_budget 必须是正整数");
    }
    result[key] = value;
  }
  return result;
}

/** 执行「sameNativeReasoning」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function sameNativeReasoning(
  left: ChatCompletionsNativeReasoning,
  right: Readonly<Record<string, string | number | boolean>>,
): boolean {
  const leftEntries = Object.entries(left).toSorted(/** 执行「leftEntries」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).toSorted(/** 执行「rightEntries」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

/** 汇总「mergeToolCallDelta」对应指标，保持缺失字段语义且不重复计算同一来源。 */
function mergeToolCallDelta(state: ToolCallState, call: Record<string, unknown>): void {
  const id = stringValue(call.id);
  if (id) {
    if (state.id && state.id !== id) {
      throw new ModelProviderError(
        "invalid_model_response",
        `Chat Completions Tool Call index ${state.index} 返回了冲突 id`,
        false,
      );
    }
    state.id = id;
  }
  const fn = recordValue(call.function);
  const name = stringValue(fn?.name);
  const argumentsDelta = stringValue(fn?.arguments);
  if (name) state.nameText += name;
  if (argumentsDelta) state.argumentsText += argumentsDelta;
}

/** 执行「completeToolCalls」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function completeToolCalls(calls: Map<number, ToolCallState>): ModelToolCall[] {
  return [...calls.values()]
    .toSorted(/** 执行「map」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(left, right) => left.index - right.index || left.firstSeen - right.firstSeen)
    .map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(state) => {
      if (!state.id || !state.nameText) {
        throw new ModelProviderError(
          "invalid_model_response",
          `Chat Completions Tool Call index ${state.index} 缺少 id 或 name`,
          false,
        );
      }
      let args: unknown;
      try {
        args = JSON.parse(state.argumentsText || "{}") as unknown;
      } catch (error) {
        throw new ModelProviderError(
          "invalid_model_response",
          `Chat Completions Tool Call ${state.id} 返回了无效 arguments JSON`,
          false,
          { cause: error },
        );
      }
      if (!isRecord(args)) {
        throw new ModelProviderError(
          "invalid_model_response",
          `Chat Completions Tool Call ${state.id} 的 arguments 必须是对象`,
          false,
        );
      }
      return {
        id: state.id,
        index: state.index,
        name: state.nameText,
        arguments: args,
      };
    });
}

/** 校验并规范化「normalizeFinishReason」输入，非法数据直接返回明确错误。 */
function normalizeFinishReason(value: string): "stop" | "length" | "cancelled" {
  if (value === "stop" || value === "tool_calls" || value === "function_call") return "stop";
  if (value === "length") return "length";
  if (value === "cancelled") return "cancelled";
  throw new ModelProviderError(
    "model_request_failed",
    `Chat Completions API 以不支持的原因停止: ${short(value, 80)}`,
    false,
  );
}

/** 读取「readUsage」所需数据，并遵守作用域、分页与容量边界。 */
function readUsage(value: unknown): ModelUsage | undefined {
  const usage = recordValue(value);
  if (!usage) return undefined;
  const input = nonNegativeNumber(usage.prompt_tokens);
  const output = nonNegativeNumber(usage.completion_tokens);
  const inputDetails = recordValue(usage.prompt_tokens_details);
  const outputDetails = recordValue(usage.completion_tokens_details);
  const cached = nonNegativeNumber(inputDetails?.cached_tokens);
  const reasoning = nonNegativeNumber(outputDetails?.reasoning_tokens);
  if (input === undefined && output === undefined && cached === undefined && reasoning === undefined) {
    return undefined;
  }
  return {
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
    ...(reasoning !== undefined ? { reasoningOutputTokens: reasoning } : {}),
  };
}

/** 执行「chatCompletionsApiUrl」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function chatCompletionsApiUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch (error) {
    throw new ModelProviderError(
      "dependency_unavailable",
      "Chat Completions API Base URL 无效",
      false,
      { cause: error },
    );
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/chat/completions`;
  url.search = "";
  url.hash = "";
  return url;
}

/** 读取「readMaxRedirects」所需数据，并遵守作用域、分页与容量边界。 */
function readMaxRedirects(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0 || value > 3) {
    throw new Error("Chat Completions maxRedirects 必须是 0 到 3 的整数");
  }
  return value;
}

/** 判断「isRedirectStatus」对应条件，只返回判定结果且不修改输入状态。 */
function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** 读取「readChoiceIndex」所需数据，并遵守作用域、分页与容量边界。 */
function readChoiceIndex(choice: Record<string, unknown>): number {
  return integerValue(choice.index) ?? 0;
}

/** 校验并规范化「parseSseJson」输入，非法数据直接返回明确错误。 */
function parseSseJson(message: SseEvent, token: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(message.data) as unknown;
  } catch (error) {
    throw new ModelProviderError(
      "invalid_model_response",
      `Chat Completions API 返回了无效 SSE JSON: ${redact(short(message.data, 120), token)}`,
      false,
      { cause: error },
    );
  }
  if (!isRecord(value)) {
    throw new ModelProviderError(
      "invalid_model_response",
      "Chat Completions API 返回了无效 SSE Event",
      false,
    );
  }
  return value;
}

/** 执行「chatError」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function chatError(error: Record<string, unknown>, token: string): ModelProviderError {
  const code = stringValue(error.code) ?? stringValue(error.type);
  const message = stringValue(error.message) ?? "Chat Completions API 返回错误事件";
  return new ModelProviderError(
    "model_request_failed",
    `Chat Completions API${code ? ` (${redact(code, token)})` : ""}: ${redact(message, token)}`,
    code !== undefined && ["rate_limit_exceeded", "server_error", "service_unavailable", "timeout"].includes(code),
  );
}

/** 读取「readSse」所需数据，并遵守作用域、分页与容量边界。 */
async function* readSse(body: ReadableStream<Uint8Array>): AsyncIterable<SseEvent> {
  let event: string | undefined;
  let data: string[] = [];
  let eventBytes = 0;
  for await (const line of readLines(body, {
    maxLineBytes: MAX_SSE_LINE_BYTES,
    maxTotalBytes: MAX_SSE_TOTAL_BYTES,
  })) {
    if (line === "") {
      if (data.length > 0) yield { ...(event ? { event } : {}), data: data.join("\n") };
      event = undefined;
      data = [];
      eventBytes = 0;
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    if (field === "data") {
      eventBytes += Buffer.byteLength(value, "utf8") + (data.length > 0 ? 1 : 0);
      if (eventBytes > MAX_SSE_EVENT_BYTES) {
        throw new ModelProviderError(
          "invalid_model_response",
          "Chat Completions API SSE 事件超过大小限制",
          false,
        );
      }
      data.push(value);
    }
  }
  if (data.length > 0) yield { ...(event ? { event } : {}), data: data.join("\n") };
}

/** 读取「readLines」所需数据，并遵守作用域、分页与容量边界。 */
async function* readLines(
  body: ReadableStream<Uint8Array>,
  limits: { maxLineBytes: number; maxTotalBytes: number },
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let finished = false;
  let totalBytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) {
        pending += decoder.decode();
        finished = true;
      } else {
        totalBytes += part.value.byteLength;
        if (totalBytes > limits.maxTotalBytes) {
          throw new ModelProviderError(
            "invalid_model_response",
            "Chat Completions API SSE 流超过大小限制",
            false,
          );
        }
        pending += decoder.decode(part.value, { stream: true });
      }
      while (true) {
        const separator = nextLineSeparator(pending, finished);
        if (!separator) break;
        const line = pending.slice(0, separator.index);
        if (Buffer.byteLength(line, "utf8") > limits.maxLineBytes) {
          throw new ModelProviderError(
            "invalid_model_response",
            "Chat Completions API SSE 单行超过大小限制",
            false,
          );
        }
        yield line;
        pending = pending.slice(separator.index + separator.length);
      }
      if (Buffer.byteLength(pending, "utf8") > limits.maxLineBytes) {
        throw new ModelProviderError(
          "invalid_model_response",
          "Chat Completions API SSE 单行超过大小限制",
          false,
        );
      }
      if (finished) break;
    }
    if (pending) {
      if (Buffer.byteLength(pending, "utf8") > limits.maxLineBytes) {
        throw new ModelProviderError(
          "invalid_model_response",
          "Chat Completions API SSE 单行超过大小限制",
          false,
        );
      }
      yield pending;
    }
  } finally {
    if (!finished) {
      try { await reader.cancel(); } catch { /* 保留原始协议错误，不用取消失败覆盖根因。 */ }
    }
    reader.releaseLock();
  }
}

/** 执行「nextLineSeparator」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function nextLineSeparator(
  value: string,
  finished: boolean,
): { index: number; length: number } | undefined {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 10) return { index, length: 1 };
    if (code !== 13) continue;
    if (index + 1 >= value.length && !finished) return undefined;
    return { index, length: value.charCodeAt(index + 1) === 10 ? 2 : 1 };
  }
  return undefined;
}

/** 读取「readErrorBody」所需数据，并遵守作用域、分页与容量边界。 */
async function readErrorBody(response: Response): Promise<string> {
  try { return short((await readLimitedText(response, MAX_HTTP_ERROR_BODY_BYTES)).trim(), 300); }
  catch { return ""; }
}

/** 读取「readLimitedText」所需数据，并遵守作用域、分页与容量边界。 */
async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = "";
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) {
        result += decoder.decode();
        return result;
      }
      const remaining = maxBytes - bytes;
      if (remaining <= 0) {
        await reader.cancel().catch(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => undefined);
        return `${result}…`;
      }
      const accepted = part.value.byteLength <= remaining
        ? part.value
        : part.value.subarray(0, remaining);
      bytes += accepted.byteLength;
      result += decoder.decode(accepted, { stream: part.value.byteLength <= remaining });
      if (part.value.byteLength > remaining) {
        result += decoder.decode();
        await reader.cancel().catch(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => undefined);
        return `${result}…`;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

const SENSITIVE_FIELDS = [
  "encrypted_content",
  "authorization",
  "api_key",
  "apiKey",
  "access_token",
  "refresh_token",
  "token",
  "secret",
  "password",
] as const;

/** 执行「redact」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function redact(value: string, token: string): string {
  let redacted = token ? value.split(token).join("[REDACTED]") : value;
  try {
    redacted = JSON.stringify(redactSensitiveJson(JSON.parse(redacted) as unknown));
  } catch {
    for (const name of SENSITIVE_FIELDS) {
      redacted = redacted.replace(
        new RegExp(
          `(^|[\\s{[(,;])(["']?${escapeRegExp(name)}["']?\\s*[:=]\\s*)`
            + `(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^,;\\r\\n}\\]]*)`,
          "gim",
        ),
        "$1$2[REDACTED]",
      );
    }
  }
  return short(redacted, 300);
}

/** 执行「redactSensitiveJson」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function redactSensitiveJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitiveJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
([key, item]) => [
    key,
    SENSITIVE_FIELDS.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(name) => name.toLowerCase() === key.toLowerCase())
      ? "[REDACTED]"
      : redactSensitiveJson(item),
  ]));
}

/** 执行「escapeRegExp」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 读取「readPositiveInteger」所需数据，并遵守作用域、分页与容量边界。 */
function readPositiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${field} 必须是正整数`);
  return value;
}

/** 执行「integerValue」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

/** 执行「nonNegativeNumber」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** 执行「stringValue」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** 更新「recordValue」对应状态，并保持写入顺序、原子性与容量约束。 */
function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

/** 判断「isRecord」对应条件，只返回判定结果且不修改输入状态。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 执行「short」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function short(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}

/** 判断「isAbort」对应条件，只返回判定结果且不修改输入状态。 */
function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || isRecord(error) && error.name === "AbortError";
}
