import { randomUUID } from "node:crypto";
import { isRetryableModelHttpStatus, ModelProviderError, retryAfterMilliseconds } from "./model-error.js";
import type {
  ConcreteReasoningProfile,
  ModelReasoningCapability,
} from "@kindergarten/contracts";
import { readModelReasoningCapability } from "@kindergarten/contracts";
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
  assertContinuationTargetsStudent,
  createProviderOpaqueContinuation,
  readProviderOpaqueContinuation,
  type JsonObject,
  type ProviderOpaqueContinuation,
} from "./provider-continuation.js";
import {
  GlobalFetchHttpTransport,
  PinnedHttpTransport,
  type HttpEndpointResolver,
  type OutboundHttpTransport,
} from "./pinned-http-transport.js";

/** 描述「ResponsesApiProviderOptions」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ResponsesApiProviderOptions {
  readBearerToken(): string | Promise<string>;
  /**
   * 入园体检后持久化的真实能力。未知自定义模型不允许凭名称猜测。
   * 真实自定义连接必须提供；旧 fixture 只能显式打开 allowLegacyOfficialPreset。
   */
  reasoning?: ResponsesReasoningConfiguration;
  /** 只供旧的本地协议 fixture；真实自定义连接必须传入入园体检快照。 */
  allowLegacyOfficialPreset?: boolean;
  /** 每次实际请求和每一跳显式重定向前调用，供 Remote 注入 DNS/地址策略。 */
  endpointGuard?: (url: URL) => void | Promise<void>;
  /**
   * 生产自定义端点必须注入：一次返回审核 URL 与公网地址票据，并把该地址绑定到 socket lookup，
   * 从而消除安全检查后由 global fetch 再次 DNS 的重绑定窗口。
   */
  endpointResolver?: HttpEndpointResolver;
  /** 默认拒绝重定向；显式开启时仍只允许保留 POST 的 307/308，最大 3 跳。 */
  maxRedirects?: number;
}

/** 描述「ResponsesReasoningConfiguration」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ResponsesReasoningConfiguration {
  capability: ModelReasoningCapability;
  efforts: Partial<Record<ConcreteReasoningProfile, string>>;
}

/** 描述「ResponsesProbeStreamOptions」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ResponsesProbeStreamOptions {
  maxOutputTokens?: number;
  toolChoice?: "none" | "auto" | { type: "function"; name: string };
  onTerminalResponse?: (response: Readonly<Record<string, unknown>>) => void;
}

interface FunctionCallState {
  index: number;
  itemId?: string;
  callId?: string;
  name?: string;
  argumentsText: string;
  started: boolean;
  emitted: boolean;
}

interface TextItemState {
  id: string;
  kind: "reasoning" | "message";
  text: string;
  started: boolean;
  completed: boolean;
}

interface SseEvent {
  event?: string;
  data: string;
}

type ResponsesStreamDisposition = "yielded" | "buffered" | "ignored" | "terminal";

interface ResponsesStreamDiagnostics {
  record(
    message: SseEvent,
    type: string,
    event: Record<string, unknown> | undefined,
    disposition: ResponsesStreamDisposition,
  ): void;
}

const MAX_SSE_LINE_BYTES = 1024 * 1024;
const MAX_SSE_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_SSE_STREAM_BYTES = 64 * 1024 * 1024;
const MAX_HTTP_ERROR_BODY_BYTES = 64 * 1024;

/** OpenAI Responses 兼容层；store=false 下通过完整 output items 显式续接。 */
export class ResponsesApiProvider implements ModelProvider {
  private readonly readBearerToken: ResponsesApiProviderOptions["readBearerToken"];
  private readonly endpointGuard: NonNullable<ResponsesApiProviderOptions["endpointGuard"]>;
  private readonly httpTransport: OutboundHttpTransport;
  private readonly maxRedirects: number;
  readonly reasoningCapability: ModelReasoningCapability;
  private readonly reasoningEfforts: Readonly<Partial<Record<ConcreteReasoningProfile, string>>>;

  /** 初始化「ResponsesApiProvider」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(
    readonly student: ModelStudent,
    options: ResponsesApiProviderOptions,
  ) {
    if (student.provider.kind !== "openai-compatible") {
      throw new Error("ResponsesApiProvider 只能接收 openai-compatible ModelStudent");
    }
    this.readBearerToken = options.readBearerToken;
    this.endpointGuard = options.endpointGuard ?? (/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
() => undefined);
    this.httpTransport = options.endpointResolver
      ? new PinnedHttpTransport(options.endpointResolver)
      : new GlobalFetchHttpTransport();
    this.maxRedirects = readMaxRedirects(options.maxRedirects);
    const reasoning = options.reasoning
      ?? (options.allowLegacyOfficialPreset ? officialReasoningPreset(student.provider.model) : undefined);
    if (!reasoning) {
      throw new Error(
        `自定义 Responses 模型 ${student.provider.model} 缺少入园体检产生的 reasoning 能力配置`,
      );
    }
    validateReasoningConfiguration(reasoning);
    this.reasoningCapability = readModelReasoningCapability(reasoning.capability);
    this.reasoningEfforts = Object.freeze({ ...reasoning.efforts });
  }

  /** 执行「nativeReasoning」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
nativeReasoning(profile: ConcreteReasoningProfile): Record<string, string> {
    const effort = this.reasoningEfforts[profile];
    if (!effort) throw new Error(`Responses 模型不支持推理档位: ${profile}`);
    return { effort };
  }

  /** 执行「serializeContext」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
serializeContext(fragment: ModelContextFragment): ModelContextSerialization {
    let value: unknown;
    switch (fragment.kind) {
      case "system":
        value = { instructions: fragment.content };
        break;
      case "tools":
        value = fragment.tools.map(toResponsesTool);
        break;
      case "messages":
        value = fragment.messages.flatMap(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(message) => toResponsesDisclosureItems(this.student, message));
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
      value: JSON.stringify(toResponsesDisclosureRequest(this.student, input), null, 2),
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

  /** 入园体检专用；复用正式 SSE/终态解析，但允许限制输出并强制无副作用探针 Tool。 */
  async *streamProbe(
    input: ModelInput,
    signal: AbortSignal,
    options: ResponsesProbeStreamOptions,
  ): AsyncIterable<ModelEvent> {
    yield* this.streamRequest(input, signal, options);
  }

  /** 执行「streamRequest」主流程，传播取消与失败并在结束时清理临时资源。 */
private async *streamRequest(
    input: ModelInput,
    signal: AbortSignal,
    options: ResponsesProbeStreamOptions,
    onActivity?: () => void,
  ): AsyncIterable<ModelEvent> {
    const token = await this.loadToken();
    let response: Response;
    try {
      response = await this.fetchResponse(
        responsesApiUrl(this.student.provider.baseUrl),
        JSON.stringify(toResponsesRequest(this.student, input, options)),
        token,
        signal,
      );
    } catch (error) {
      if (isAbort(error) || signal.aborted) throw error;
      if (error instanceof ModelProviderError) throw error;
      throw new ModelProviderError(
        "dependency_unavailable",
        `无法连接 Responses API${error instanceof Error ? `: ${short(error.message, 160)}` : ""}`,
        true,
        { cause: error },
      );
    }

    if (!response.ok) {
      const detail = redact(await readErrorBody(response), token);
      const retryAfterMs = retryAfterMilliseconds(response.headers.get("retry-after"));
      throw new ModelProviderError(
        "model_request_failed",
        `Responses API 请求失败 (${response.status})${detail ? `: ${detail}` : ""}`,
        isRetryableModelHttpStatus(response.status),
        {
          httpStatus: response.status,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        },
      );
    }
    if (!response.body) {
      throw new ModelProviderError(
        "invalid_model_response",
        "Responses API 响应没有流式 Body",
        false,
      );
    }

    const calls = new Map<number, FunctionCallState>();
    const itemIndexes = new Map<string, number>();
    const textItems = new Map<string, TextItemState>();
    const textItemIndexes = new Map<string, string>();
    let terminal = false;
    const diagnostics = createResponsesStreamDiagnostics();

    for await (const message of readSse(response.body)) {
      onActivity?.();
      if (message.data === "[DONE]") {
        diagnostics?.record(message, "[DONE]", undefined, "terminal");
        // [DONE] 只是传输层尾帧；只有 response.completed/incomplete/cancelled
        // 才能证明 response.output 已完整到达并可安全续接。
        continue;
      }

      const event = parseSseJson(message);
      const type = stringValue(event.type) ?? message.event;
      if (!type) continue;
      diagnostics?.record(message, type, event, responsesStreamDisposition(type));

      if (type === "response.output_text.delta") {
        const itemId = textItemId(event, "message", textItemIndexes);
        const state = ensureTextItem(textItems, itemId, "message");
        if (!state.started) {
          state.started = true;
          yield { type: "output_item_started", item: { id: itemId, kind: "message" } };
        }
        const delta = stringValue(event.delta);
        if (delta) {
          state.text += delta;
          yield { type: "output_item_delta", itemId, delta: { kind: "text", text: delta } };
        }
        continue;
      }
      if (
        type === "response.reasoning_summary_text.delta" ||
        type === "response.reasoning_text.delta"
      ) {
        const itemId = textItemId(event, "reasoning", textItemIndexes);
        const state = ensureTextItem(textItems, itemId, "reasoning");
        if (!state.started) {
          state.started = true;
          yield { type: "output_item_started", item: { id: itemId, kind: "reasoning" } };
        }
        const delta = stringValue(event.delta);
        if (delta) {
          state.text += delta;
          yield { type: "output_item_delta", itemId, delta: { kind: "text", text: delta } };
        }
        continue;
      }

      if (type === "response.output_item.added") {
        const item = recordValue(event.item);
        if (item?.type === "function_call") {
          const state = seedFunctionCall(calls, itemIndexes, event, item);
          if (!state.itemId || !state.callId) {
            throw new ModelProviderError(
              "invalid_model_response",
              "Responses function_call item 缺少稳定 id 或 call_id",
              false,
            );
          }
          state.started = true;
          yield {
            type: "output_item_started",
            item: {
              id: state.itemId,
              kind: "tool_call",
              callId: state.callId,
              ...(state.name ? { name: state.name } : {}),
            },
          };
        } else if (item?.type === "reasoning" || item?.type === "message") {
          const itemId = textItemId(event, item.type === "reasoning" ? "reasoning" : "message", textItemIndexes, item);
          if (!itemId) {
            throw new ModelProviderError("invalid_model_response", "Responses output item 缺少稳定 id", false);
          }
          const kind = item.type === "reasoning" ? "reasoning" : "message";
          const state = ensureTextItem(textItems, itemId, kind);
          if (!state.started) {
            state.started = true;
            yield { type: "output_item_started", item: { id: itemId, kind } };
          }
        }
        continue;
      }
      if (type === "response.function_call_arguments.delta") {
        const state = functionCallForEvent(calls, itemIndexes, event);
        const delta = stringValue(event.delta);
        if (!state.itemId) throw new ModelProviderError("invalid_model_response", "Responses Tool Call delta 缺少 item_id", false);
        if (!state.started) {
          if (!state.callId) {
            throw new ModelProviderError(
              "invalid_model_response",
              "Responses Tool Call delta 在 added 前到达且缺少 call_id",
              false,
            );
          }
          state.started = true;
          yield {
            type: "output_item_started",
            item: {
              id: state.itemId,
              kind: "tool_call",
              callId: state.callId,
              ...(state.name ? { name: state.name } : {}),
            },
          };
        }
        if (delta) {
          state.argumentsText += delta;
          yield {
            type: "output_item_delta",
            itemId: state.itemId,
            delta: { kind: "tool_arguments", text: delta },
          };
        }
        continue;
      }
      if (type === "response.function_call_arguments.done") {
        const state = functionCallForEvent(calls, itemIndexes, event);
        const args = stringValue(event.arguments);
        if (args !== undefined) state.argumentsText = args;
        continue;
      }
      if (type === "response.output_item.done") {
        const item = recordValue(event.item);
        if (item?.type === "function_call") {
          const state = seedFunctionCall(calls, itemIndexes, event, item);
          const call = completeFunctionCall(state);
          if (!state.itemId || !call) {
            throw new ModelProviderError("invalid_model_response", "Responses function_call item 无法完成", false);
          }
          if (!state.started) {
            state.started = true;
            yield {
              type: "output_item_started",
              item: {
                id: state.itemId,
                kind: "tool_call",
                callId: call.id ?? state.callId ?? state.itemId,
                name: call.name,
              },
            };
          }
          yield {
            type: "output_item_completed",
            item: { id: state.itemId, kind: "tool_call", call },
          };
        } else if (item?.type === "reasoning" || item?.type === "message") {
          const kind = item.type === "reasoning" ? "reasoning" : "message";
          const itemId = textItemId(event, kind, textItemIndexes, item);
          const state = ensureTextItem(textItems, itemId, kind);
          if (!state.started) {
            state.started = true;
            yield { type: "output_item_started", item: { id: itemId, kind } };
          }
          if (state.completed) {
            throw new ModelProviderError("invalid_model_response", `Responses output item ${itemId} 重复完成`, false);
          }
          state.completed = true;
          const text = completedItemText(item, kind) ?? state.text;
          state.text = text;
          yield { type: "output_item_completed", item: { id: itemId, kind, text } };
        }
        continue;
      }

      if (type === "response.completed" || type === "response.incomplete") {
        const responseValue = recordValue(event.response);
        if (responseValue) {
          options.onTerminalResponse?.(responseValue);
          for (const call of callsFromResponse(responseValue, calls, itemIndexes)) {
            const state = [...calls.values()].find((candidate) => candidate.callId === call.id);
            if (!state?.itemId || !state.callId) {
              throw new ModelProviderError("invalid_model_response", "Responses 终态 Tool Call 缺少 item 身份", false);
            }
            if (!state.started) {
              state.started = true;
              yield {
                type: "output_item_started",
                item: {
                  id: state.itemId,
                  kind: "tool_call",
                  callId: state.callId,
                  ...(state.name ? { name: state.name } : {}),
                },
              };
            }
            yield { type: "output_item_completed", item: { id: state.itemId, kind: "tool_call", call } };
          }
          if (Array.isArray(responseValue.output)) {
            for (let index = 0; index < responseValue.output.length; index += 1) {
              const item = recordValue(responseValue.output[index]);
              if (item?.type !== "reasoning" && item?.type !== "message") continue;
              const kind = item.type === "reasoning" ? "reasoning" : "message";
              const implicit = [...textItems.values()].find((state) => state.kind === kind && !state.completed);
              const itemId = textItemIndexes.get(`${index}:${kind}`) ?? implicit?.id ?? stringValue(item.id) ?? `responses:${index}:${kind}`;
              const existing = textItems.get(itemId);
              if (existing?.completed) continue;
              const state = existing ?? ensureTextItem(textItems, itemId, kind);
              if (!state.started) {
                state.started = true;
                yield { type: "output_item_started", item: { id: itemId, kind } };
              }
              state.completed = true;
              const text = completedItemText(item, kind) ?? state.text;
              state.text = text;
              yield { type: "output_item_completed", item: { id: itemId, kind, text } };
            }
          }
          const usage = readUsage(responseValue.usage);
          if (usage) yield { type: "usage", ...usage };
          const continuation = responseContinuation(this.student, responseValue);
          if (!continuation && calls.size > 0) {
            throw new ModelProviderError(
              "invalid_model_response",
              "Responses Tool Call 缺少可用于 store=false 续接的 response.output",
              false,
            );
          }
          if (continuation) yield { type: "provider_continuation", continuation };
        }
        terminal = true;
        yield {
          type: "finish",
          reason: type === "response.incomplete" ? "length" : "stop",
        };
        continue;
      }
      if (type === "response.cancelled") {
        terminal = true;
        yield { type: "finish", reason: "cancelled" };
        continue;
      }
      if (type === "response.failed") {
        throw responseFailure(event, token);
      }
      if (type === "error") {
        throw eventFailure(event, token);
      }
    }

    if (!terminal) {
      throw new ModelProviderError(
        "invalid_model_response",
        "Responses API 流在终止事件前结束",
        false,
      );
    }
  }

  /** 读取「loadToken」所需数据，并遵守作用域、分页与容量边界。 */
private async loadToken(): Promise<string> {
    let token: string;
    try {
      token = (await this.readBearerToken()).trim();
    } catch (error) {
      throw new ModelProviderError(
        "dependency_unavailable",
        "无法读取 Responses API 凭据",
        false,
        { cause: error },
      );
    }
    if (!token) {
      throw new ModelProviderError(
        "dependency_unavailable",
        "Responses API 凭据为空",
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
          `Responses API 返回不允许的重定向 (${response.status})`,
          false,
        );
      }
      const location = response.headers.get("location");
      await response.body?.cancel().catch(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => undefined);
      if (!location) {
        throw new ModelProviderError(
          "invalid_model_response",
          "Responses API 重定向缺少 Location",
          false,
        );
      }
      url = new URL(location, url);
    }
  }
}

/**
 * 只在显式诊断开关下记录原始 SSE 的时间和大小事实。
 * 严禁写入 data、delta、请求体、端点或凭据，避免诊断日志成为第二份 Session/Secret。
 */
function createResponsesStreamDiagnostics(): ResponsesStreamDiagnostics | undefined {
  if (process.env.MK_RESPONSES_STREAM_DIAGNOSTICS !== "1") return undefined;
  const requestId = randomUUID();
  const startedAt = Date.now();
  let previousEventAt = startedAt;
  return {
    record(message, type, event, disposition) {
      const now = Date.now();
      const delta = event ? stringValue(event.delta) : undefined;
      console.warn("[responses-stream]", JSON.stringify({
        requestId,
        at: new Date(now).toISOString(),
        elapsedMs: now - startedAt,
        gapMs: now - previousEventAt,
        type,
        dataBytes: Buffer.byteLength(message.data),
        deltaBytes: delta ? Buffer.byteLength(delta) : 0,
        disposition,
      }));
      previousEventAt = now;
    },
  };
}

/** 归类 Adapter 对原始 Responses 事件的处理方式，只暴露固定枚举而不复制事件内容。 */
function responsesStreamDisposition(type: string): ResponsesStreamDisposition {
  if (
    type === "response.output_text.delta"
    || type === "response.reasoning_summary_text.delta"
    || type === "response.reasoning_text.delta"
    || type === "response.function_call_arguments.done"
    || type === "response.output_item.done"
  ) return "yielded";
  if (
    type === "response.output_item.added"
    || type === "response.function_call_arguments.delta"
  ) return "buffered";
  if (
    type === "response.completed"
    || type === "response.incomplete"
    || type === "response.cancelled"
    || type === "response.failed"
    || type === "error"
  ) return "terminal";
  return "ignored";
}

/** 根据已校验输入构建「toResponsesRequest」结果，不额外持有调用方的大对象。 */
function toResponsesRequest(
  student: ModelStudent,
  input: ModelInput,
  options: ResponsesProbeStreamOptions = {},
): Record<string, unknown> {
  const reasoning = responsesReasoning(student, input);
  const acceptsTemperature = !reasoning || reasoning.effort === "none";
  return {
    model: student.provider.model,
    instructions: input.systemPrompt,
    input: input.messages.flatMap(/** 执行「input」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(message) => toResponsesInputItems(student, message)),
    tools: input.tools.map(toResponsesTool),
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
    ...(options.maxOutputTokens !== undefined
      ? { max_output_tokens: options.maxOutputTokens }
      : {}),
    ...(options.toolChoice !== undefined
      ? { tool_choice: structuredClone(options.toolChoice) }
      : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(acceptsTemperature && student.generationDefaults.temperature !== undefined
      ? { temperature: student.generationDefaults.temperature }
      : {}),
  };
}

/** 根据已校验输入构建「toResponsesDisclosureRequest」结果，不额外持有调用方的大对象。 */
function toResponsesDisclosureRequest(
  student: ModelStudent,
  input: ModelInput,
): Record<string, unknown> {
  const request = toResponsesRequest(student, input);
  return {
    ...request,
    input: input.messages.flatMap(/** 执行「input」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(message) => toResponsesDisclosureItems(student, message)),
  };
}

/** 执行「responsesReasoning」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function responsesReasoning(
  student: ModelStudent,
  input: ModelInput,
): { effort: string; summary?: "auto" } | undefined {
  if (input.reasoning === "disabled") return { effort: "none" };
  if (input.reasoning === undefined) return undefined;
  assertSnapshotTargetsStudent(student, input.reasoning);
  const effort = input.reasoning.native.effort;
  if (typeof effort !== "string" || effort.length === 0) {
    throw new ModelProviderError(
      "model_request_failed",
      "Responses 推理快照缺少 native.effort",
      false,
    );
  }
  return { effort, summary: "auto" };
}

/** 校验并规范化「assertSnapshotTargetsStudent」输入，非法数据直接返回明确错误。 */
function assertSnapshotTargetsStudent(
  student: ModelStudent,
  snapshot: Exclude<ModelInput["reasoning"], "disabled" | undefined>,
): void {
  if (
    snapshot.providerKind !== student.provider.kind ||
    snapshot.model !== student.provider.model
  ) {
    throw new ModelProviderError(
      "model_request_failed",
      "推理快照与当前 Responses ModelStudent 不匹配",
      false,
    );
  }
}

/** 执行「officialReasoningPreset」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function officialReasoningPreset(model: string): ResponsesReasoningConfiguration | undefined {
  if (model !== "gpt-5.5" && !/^gpt-5\.5-\d{4}-\d{2}-\d{2}$/.test(model)) return undefined;
  return {
    capability: {
      schemaVersion: 1,
      control: "effort_levels",
      adjustable: true,
      supportedProfiles: ["fast", "balanced", "deep", "max"],
      defaultProfile: "balanced",
      native: {
        parameter: "reasoning.effort",
        values: ["low", "medium", "high", "xhigh"],
      },
    },
    efforts: {
      fast: "low",
      balanced: "medium",
      deep: "high",
      max: "xhigh",
    },
  };
}

/** 校验并规范化「validateReasoningConfiguration」输入，非法数据直接返回明确错误。 */
function validateReasoningConfiguration(config: ResponsesReasoningConfiguration): void {
  const capability = readModelReasoningCapability(config.capability);
  if (capability.control !== "effort_levels" && capability.control !== "fixed") {
    throw new Error("Responses reasoning 只接受 fixed 或 effort_levels 能力");
  }
  if (capability.native?.parameter !== "reasoning.effort") {
    throw new Error("Responses reasoning native.parameter 必须是 reasoning.effort");
  }
  for (const profile of capability.supportedProfiles) {
    const effort = config.efforts[profile];
    if (typeof effort !== "string" || effort.length === 0) {
      throw new Error(`Responses reasoning 档位 ${profile} 缺少原生 effort 映射`);
    }
    if (capability.native.values && !capability.native.values.includes(effort)) {
      throw new Error(`Responses reasoning 档位 ${profile} 映射到未声明的 effort: ${effort}`);
    }
  }
}

/** 根据已校验输入构建「toResponsesTool」结果，不额外持有调用方的大对象。 */
function toResponsesTool(tool: ModelToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  };
}

/** 根据已校验输入构建「toResponsesInputItems」结果，不额外持有调用方的大对象。 */
function toResponsesInputItems(
  student: ModelStudent,
  message: ModelMessage,
): Record<string, unknown>[] {
  if (message.role === "tool") {
    if (!message.toolCallId) {
      throw new ModelProviderError(
        "invalid_model_response",
        "Tool Result 缺少 toolCallId，无法生成 function_call_output",
        false,
      );
    }
    return [{
      type: "function_call_output",
      call_id: message.toolCallId,
      output: message.content,
    }];
  }

  if (message.role === "assistant" && message.providerOpaqueContinuation) {
    const continuation = message.providerOpaqueContinuation
      ? readProviderOpaqueContinuation(message.providerOpaqueContinuation)
      : undefined;
    if (continuation) assertContinuationTargetsStudent(continuation, student, "openai_responses");
    const continuationItems = continuation
      ? readResponsesContinuationItems(continuation)
      : undefined;
    const items: Record<string, unknown>[] = continuation
      ? structuredClone(continuationItems ?? [])
      : message.content ? [{ role: "assistant", content: message.content }] : [];
    const continuedCallIds = continuationItems
      ? new Set(responsesContinuationFunctionCallIds(continuationItems))
      : new Set<string>();
    for (const call of message.toolCalls ?? []) {
      if (!call.id) {
        throw new ModelProviderError(
          "invalid_model_response",
          "Assistant Tool Call 缺少 id，无法续接 Responses 请求",
          false,
        );
      }
      if (continuedCallIds.has(call.id)) continue;
      items.push({
        type: "function_call",
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      });
    }
    return items;
  }

  if (message.role === "assistant" && message.toolCalls?.length) {
    const items: Record<string, unknown>[] = message.content
      ? [{ role: "assistant", content: message.content }]
      : [];
    for (const call of message.toolCalls) {
      if (!call.id) {
        throw new ModelProviderError(
          "invalid_model_response",
          "Assistant Tool Call 缺少 id，无法续接 Responses 请求",
          false,
        );
      }
      items.push({
        type: "function_call",
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      });
    }
    return items;
  }

  return [{ role: message.role, content: message.content }];
}

/** 根据已校验输入构建「toResponsesDisclosureItems」结果，不额外持有调用方的大对象。 */
function toResponsesDisclosureItems(
  student: ModelStudent,
  message: ModelMessage,
): Record<string, unknown>[] {
  const items = toResponsesInputItems(student, message);
  if (!message.providerOpaqueContinuation) return items;
  return items.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => {
    if (item.type === "function_call") {
      return {
        type: item.type,
        ...(typeof item.call_id === "string" ? { call_id: item.call_id } : {}),
        ...(typeof item.name === "string" ? { name: item.name } : {}),
        providerOpaque: true,
      };
    }
    return {
      type: typeof item.type === "string" ? item.type : "unknown",
      providerOpaque: true,
      byteLength: Buffer.byteLength(JSON.stringify(item), "utf8"),
    };
  });
}

/** 执行「responseContinuation」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function responseContinuation(
  student: ModelStudent,
  response: Record<string, unknown>,
): ProviderOpaqueContinuation | undefined {
  if (!Array.isArray(response.output) || response.output.length === 0) return undefined;
  try {
    if (!response.output.every(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => isRecord(item))) {
      throw new Error("response.output item 必须是 JSON 对象");
    }
    const items = response.output as JsonObject[];
    return createProviderOpaqueContinuation({
      modelStudentId: student.id,
      providerKind: student.provider.kind,
      protocol: "openai_responses",
      model: student.provider.model,
      format: "openai-responses-output-v1",
      payload: { items },
      correlation: {
        toolCallIds: responsesContinuationFunctionCallIds(items),
      },
    });
  } catch (error) {
    throw new ModelProviderError(
      "invalid_model_response",
      "Responses API response.output 不是可持久化的 JSON items",
      false,
      { cause: error },
    );
  }
}

/** 读取「readResponsesContinuationItems」所需数据，并遵守作用域、分页与容量边界。 */
function readResponsesContinuationItems(
  continuation: ProviderOpaqueContinuation,
): JsonObject[] {
  if (continuation.format !== "openai-responses-output-v1") {
    throw new Error("Responses continuation format 不受支持");
  }
  const payload = continuation.payload;
  if (
    !isRecord(payload) ||
    !Array.isArray(payload.items) ||
    !payload.items.every(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => isRecord(item))
  ) {
    throw new Error("Responses continuation payload.items 必须是 JSON 对象数组");
  }
  return structuredClone(payload.items) as JsonObject[];
}

/** 执行「responsesContinuationFunctionCallIds」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function responsesContinuationFunctionCallIds(items: JsonObject[]): string[] {
  return items.flatMap(/** 执行「responsesContinuationFunctionCallIds」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(item) =>
    item.type === "function_call" && typeof item.call_id === "string"
      ? [item.call_id]
      : [],
  );
}

/** 执行「responsesApiUrl」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function responsesApiUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch (error) {
    throw new ModelProviderError(
      "dependency_unavailable",
      "Responses API Base URL 无效",
      false,
      { cause: error },
    );
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/responses`;
  url.search = "";
  url.hash = "";
  return url;
}

/** 读取「readMaxRedirects」所需数据，并遵守作用域、分页与容量边界。 */
function readMaxRedirects(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0 || value > 3) {
    throw new Error("Responses maxRedirects 必须是 0 到 3 的整数");
  }
  return value;
}

/** 判断「isRedirectStatus」对应条件，只返回判定结果且不修改输入状态。 */
function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** 执行「seedFunctionCall」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function seedFunctionCall(
  calls: Map<number, FunctionCallState>,
  itemIndexes: Map<string, number>,
  event: Record<string, unknown>,
  item: Record<string, unknown>,
): FunctionCallState {
  const index = outputIndex(event, itemIndexes, item);
  const current = calls.get(index) ?? {
    index,
    argumentsText: "",
    started: false,
    emitted: false,
  };
  const itemId = stringValue(item.id) ?? stringValue(event.item_id);
  if (itemId) {
    current.itemId = itemId;
    itemIndexes.set(itemId, index);
  }
  const callId = stringValue(item.call_id);
  const name = stringValue(item.name);
  if (callId !== undefined) current.callId = callId;
  if (name !== undefined) current.name = name;
  current.argumentsText = stringValue(item.arguments) ?? current.argumentsText;
  calls.set(index, current);
  return current;
}

/** 执行「functionCallForEvent」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function functionCallForEvent(
  calls: Map<number, FunctionCallState>,
  itemIndexes: Map<string, number>,
  event: Record<string, unknown>,
): FunctionCallState {
  const index = outputIndex(event, itemIndexes);
  const current = calls.get(index) ?? {
    index,
    argumentsText: "",
    started: false,
    emitted: false,
  };
  const itemId = stringValue(event.item_id);
  if (itemId) {
    current.itemId = itemId;
    itemIndexes.set(itemId, index);
  }
  const callId = stringValue(event.call_id);
  const name = stringValue(event.name);
  if (callId !== undefined) current.callId = callId;
  if (name !== undefined) current.name = name;
  calls.set(index, current);
  return current;
}

/** 执行「outputIndex」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function outputIndex(
  event: Record<string, unknown>,
  itemIndexes: Map<string, number>,
  item?: Record<string, unknown>,
): number {
  if (typeof event.output_index === "number" && Number.isInteger(event.output_index)) {
    return event.output_index;
  }
  const itemId = stringValue(event.item_id) ?? (item ? stringValue(item.id) : undefined);
  const known = itemId ? itemIndexes.get(itemId) : undefined;
  if (known !== undefined) return known;
  throw new ModelProviderError(
    "invalid_model_response",
    "Responses Tool Call 事件缺少稳定的 output_index",
    false,
  );
}

/**
 * 标准 Responses 使用 item_id；少数兼容端点只返回 output_index，此时在单次流内
 * 合成稳定身份，并在终态 response.output 到达时仍完成同一个 item。
 */
function textItemId(
  event: Record<string, unknown>,
  kind: TextItemState["kind"],
  indexes: Map<string, string>,
  item?: Record<string, unknown>,
): string {
  const index = typeof event.output_index === "number" && Number.isInteger(event.output_index)
    ? event.output_index
    : undefined;
  const explicit = stringValue(event.item_id) ?? (item ? stringValue(item.id) : undefined);
  const key = index === undefined ? undefined : `${index}:${kind}`;
  const known = key === undefined ? undefined : indexes.get(key);
  const id = known ?? explicit ?? (index === undefined ? `responses:implicit:${kind}` : `responses:${index}:${kind}`);
  if (key !== undefined) indexes.set(key, id);
  return id;
}

/** 建立或读取文本 item，并拒绝同一 id 在 reasoning/message 之间漂移。 */
function ensureTextItem(
  items: Map<string, TextItemState>,
  id: string,
  kind: TextItemState["kind"],
): TextItemState {
  const current = items.get(id);
  if (current) {
    if (current.kind !== kind) {
      throw new ModelProviderError(
        "invalid_model_response",
        `Responses output item ${id} 类型从 ${current.kind} 变为 ${kind}`,
        false,
      );
    }
    if (current.completed) {
      throw new ModelProviderError("invalid_model_response", `Responses output item ${id} 完成后仍返回增量`, false);
    }
    return current;
  }
  const state: TextItemState = { id, kind, text: "", started: false, completed: false };
  items.set(id, state);
  return state;
}

/** 从 output_item.done 的完整快照读取终态文本；未知形状交给已累计 delta。 */
function completedItemText(
  item: Record<string, unknown>,
  kind: TextItemState["kind"],
): string | undefined {
  const parts = kind === "reasoning" ? item.summary : item.content;
  if (!Array.isArray(parts)) return undefined;
  const text = parts.flatMap((part) => {
    const value = recordValue(part);
    return typeof value?.text === "string" ? [value.text] : [];
  }).join("");
  return text || undefined;
}

/** 执行「completeFunctionCall」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function completeFunctionCall(state: FunctionCallState): ModelToolCall | undefined {
  if (state.emitted || !state.callId || !state.name) return undefined;
  let args: unknown;
  try {
    args = JSON.parse(state.argumentsText || "{}") as unknown;
  } catch (error) {
    throw new ModelProviderError(
      "invalid_model_response",
      `Responses Tool Call ${state.callId} 返回了无效 arguments JSON`,
      false,
      { cause: error },
    );
  }
  if (!isRecord(args)) {
    throw new ModelProviderError(
      "invalid_model_response",
      `Responses Tool Call ${state.callId} 的 arguments 必须是对象`,
      false,
    );
  }
  state.emitted = true;
  return {
    id: state.callId,
    index: state.index,
    name: state.name,
    arguments: args,
  };
}

/** 执行「callsFromResponse」主流程，传播取消与失败并在结束时清理临时资源。 */
function callsFromResponse(
  response: Record<string, unknown>,
  calls: Map<number, FunctionCallState>,
  itemIndexes: Map<string, number>,
): ModelToolCall[] {
  if (!Array.isArray(response.output)) return [];
  const completed: ModelToolCall[] = [];
  for (let index = 0; index < response.output.length; index += 1) {
    const item = recordValue(response.output[index]);
    if (item?.type !== "function_call") continue;
    const state = seedFunctionCall(calls, itemIndexes, { output_index: index }, item);
    const call = completeFunctionCall(state);
    if (call) completed.push(call);
  }
  return completed;
}

/** 读取「readUsage」所需数据，并遵守作用域、分页与容量边界。 */
function readUsage(value: unknown): ModelUsage | undefined {
  const usage = recordValue(value);
  if (!usage) return undefined;
  const input = numberValue(usage.input_tokens);
  const output = numberValue(usage.output_tokens);
  const inputDetails = recordValue(usage.input_tokens_details);
  const outputDetails = recordValue(usage.output_tokens_details);
  const cached = numberValue(inputDetails?.cached_tokens);
  const reasoning = numberValue(outputDetails?.reasoning_tokens);
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

/** 执行「responseFailure」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function responseFailure(event: Record<string, unknown>, token: string): ModelProviderError {
  const response = recordValue(event.response);
  const error = recordValue(response?.error);
  const code = stringValue(error?.code);
  const message = stringValue(error?.message) ?? "Responses API 返回失败状态";
  const safeCode = code ? redact(code, token) : undefined;
  return new ModelProviderError(
    "model_request_failed",
    `Responses API${safeCode ? ` (${safeCode})` : ""}: ${redact(message, token)}`,
    retryableCode(code),
    safeCode ? { providerCode: safeCode } : undefined,
  );
}

/** 执行「eventFailure」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function eventFailure(event: Record<string, unknown>, token: string): ModelProviderError {
  const nested = recordValue(event.error);
  const code = stringValue(event.code) ?? stringValue(nested?.code) ?? stringValue(nested?.type);
  const message = stringValue(event.message) ?? stringValue(nested?.message) ?? "Responses API 返回错误事件";
  const safeCode = code ? redact(code, token) : undefined;
  return new ModelProviderError(
    "model_request_failed",
    `Responses API${safeCode ? ` (${safeCode})` : ""}: ${redact(message, token)}`,
    retryableCode(code),
    safeCode ? { providerCode: safeCode } : undefined,
  );
}

/** 执行「retryableCode」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function retryableCode(code: string | undefined): boolean {
  if (!code) return false;
  return ["rate_limit_exceeded", "server_error", "service_unavailable", "timeout"].includes(code);
}

/** 校验并规范化「parseSseJson」输入，非法数据直接返回明确错误。 */
function parseSseJson(message: SseEvent): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(message.data) as unknown;
  } catch (error) {
    throw new ModelProviderError(
      "invalid_model_response",
      "Responses API 返回了无效 SSE JSON",
      false,
      { cause: error },
    );
  }
  if (!isRecord(value)) {
    throw new ModelProviderError(
      "invalid_model_response",
      "Responses API 返回了无效 SSE Event",
      false,
    );
  }
  return value;
}

/** 读取「readSse」所需数据，并遵守作用域、分页与容量边界。 */
async function* readSse(body: ReadableStream<Uint8Array>): AsyncIterable<SseEvent> {
  let event: string | undefined;
  let data: string[] = [];
  let eventBytes = 0;

  for await (const line of readLines(body)) {
    eventBytes += Buffer.byteLength(line, "utf8") + 1;
    if (eventBytes > MAX_SSE_EVENT_BYTES) {
      throw responseSizeError("单个 SSE Event", MAX_SSE_EVENT_BYTES);
    }
    if (line === "") {
      if (data.length > 0) {
        yield {
          ...(event ? { event } : {}),
          data: data.join("\n"),
        };
      }
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
    if (field === "data") data.push(value);
  }

  if (data.length > 0) {
    yield {
      ...(event ? { event } : {}),
      data: data.join("\n"),
    };
  }
}

/** 读取「readLines」所需数据，并遵守作用域、分页与容量边界。 */
async function* readLines(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let finished = false;
  let streamBytes = 0;

  try {
    while (true) {
      const part = await reader.read();
      if (part.done) {
        pending += decoder.decode();
        finished = true;
      } else {
        streamBytes += part.value.byteLength;
        if (streamBytes > MAX_SSE_STREAM_BYTES) {
          throw responseSizeError("SSE 流", MAX_SSE_STREAM_BYTES);
        }
        pending += decoder.decode(part.value, { stream: true });
      }

      while (true) {
        const separator = nextLineSeparator(pending, finished);
        if (!separator) break;
        const line = pending.slice(0, separator.index);
        if (Buffer.byteLength(line, "utf8") > MAX_SSE_LINE_BYTES) {
          throw responseSizeError("SSE 单行", MAX_SSE_LINE_BYTES);
        }
        yield line;
        pending = pending.slice(separator.index + separator.length);
      }

      if (Buffer.byteLength(pending, "utf8") > MAX_SSE_LINE_BYTES) {
        throw responseSizeError("SSE 单行", MAX_SSE_LINE_BYTES);
      }

      if (finished) break;
    }
    if (pending) {
      if (Buffer.byteLength(pending, "utf8") > MAX_SSE_LINE_BYTES) {
        throw responseSizeError("SSE 单行", MAX_SSE_LINE_BYTES);
      }
      yield pending;
    }
  } finally {
    if (!finished) {
      try {
        await reader.cancel();
      } catch {
        // 上层错误优先，取消 Body 失败不应覆盖协议错误。
      }
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
    return {
      index,
      length: value.charCodeAt(index + 1) === 10 ? 2 : 1,
    };
  }
  return undefined;
}

/** 读取「readErrorBody」所需数据，并遵守作用域、分页与容量边界。 */
async function readErrorBody(response: Response): Promise<string> {
  try {
    if (!response.body) return "";
    return short((await readTextAtMost(response.body, MAX_HTTP_ERROR_BODY_BYTES)).trim(), 300);
  } catch {
    return "";
  }
}

/** 读取「readTextAtMost」所需数据，并遵守作用域、分页与容量边界。 */
async function readTextAtMost(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let result = "";
  let used = 0;
  let finished = false;
  try {
    while (used < maxBytes) {
      const part = await reader.read();
      if (part.done) {
        result += decoder.decode();
        finished = true;
        break;
      }
      const remaining = maxBytes - used;
      const accepted = part.value.byteLength <= remaining
        ? part.value
        : part.value.subarray(0, remaining);
      used += accepted.byteLength;
      result += decoder.decode(accepted, { stream: accepted.byteLength === part.value.byteLength });
      if (accepted.byteLength < part.value.byteLength) break;
    }
    if (!finished) result += decoder.decode();
    return result;
  } finally {
    if (!finished) {
      try { await reader.cancel(); } catch { /* 错误正文只是诊断信息。 */ }
    }
    reader.releaseLock();
  }
}

/** 执行「responseSizeError」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function responseSizeError(scope: string, maxBytes: number): ModelProviderError {
  return new ModelProviderError(
    "invalid_model_response",
    `Responses API ${scope} 超过 ${maxBytes} bytes 上限`,
    false,
  );
}

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

const SENSITIVE_FIELDS = [
  "encrypted_content",
  "authorization",
  "api_key",
  "apiKey",
  "access_token",
  "refresh_token",
  "secret",
  "password",
] as const;

/** 执行「redactSensitiveJson」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function redactSensitiveJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitiveJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
([key, item]) => [
    key,
    SENSITIVE_FIELDS.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(name) => name.toLocaleLowerCase() === key.toLocaleLowerCase())
      ? "[REDACTED]"
      : redactSensitiveJson(item),
  ]));
}

/** 执行「escapeRegExp」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 执行「short」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function short(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}

/** 更新「recordValue」对应状态，并保持写入顺序、原子性与容量约束。 */
function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

/** 执行「stringValue」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** 执行「numberValue」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 判断「isRecord」对应条件，只返回判定结果且不修改输入状态。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 判断「isAbort」对应条件，只返回判定结果且不修改输入状态。 */
function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
