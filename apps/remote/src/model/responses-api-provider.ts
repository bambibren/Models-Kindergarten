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

export interface ResponsesApiProviderOptions {
  readBearerToken(): string | Promise<string>;
}

interface FunctionCallState {
  index: number;
  itemId?: string;
  callId?: string;
  name?: string;
  argumentsText: string;
  emitted: boolean;
}

interface SseEvent {
  event?: string;
  data: string;
}

/**
 * OpenAI Responses 兼容层的最小核心；尚未接入 ModelStudent resolver。
 *
 * 当前实现固定使用 store=false，并以显式消息和 function_call_output 做无状态续轮。
 * 它不会保存或回放 encrypted reasoning items；需要 OpenAI ZDR 下完整推理续接时，
 * 必须另行增加 Provider 私有的 opaque continuation，不能把 summary 当作推理状态回传。
 */
export class ResponsesApiProvider implements ModelProvider {
  private readonly readBearerToken: ResponsesApiProviderOptions["readBearerToken"];

  constructor(
    readonly student: ModelStudent,
    options: ResponsesApiProviderOptions,
  ) {
    if (student.provider.kind !== "openai-compatible") {
      throw new Error("ResponsesApiProvider 只能接收 openai-compatible ModelStudent");
    }
    this.readBearerToken = options.readBearerToken;
  }

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
        value = fragment.messages.flatMap(toResponsesInputItems);
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

  async *stream(input: ModelInput, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const token = await this.loadToken();
    let response: Response;
    try {
      response = await fetch(responsesUrl(this.student.provider.baseUrl), {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(toResponsesRequest(this.student, input)),
        signal,
      });
    } catch (error) {
      if (isAbort(error) || signal.aborted) throw error;
      throw new ModelProviderError(
        "dependency_unavailable",
        "无法连接 Responses API",
        true,
        { cause: error },
      );
    }

    if (!response.ok) {
      const detail = redact(await readErrorBody(response), token);
      throw new ModelProviderError(
        "model_request_failed",
        `Responses API 请求失败 (${response.status})${detail ? `: ${detail}` : ""}`,
        response.status === 429 || response.status >= 500,
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
    let terminal = false;

    for await (const message of readSse(response.body)) {
      if (message.data === "[DONE]") {
        if (!terminal) {
          terminal = true;
          yield { type: "finish", reason: "stop" };
        }
        continue;
      }

      const event = parseSseJson(message);
      const type = stringValue(event.type) ?? message.event;
      if (!type) continue;

      if (type === "response.output_text.delta") {
        const delta = stringValue(event.delta);
        if (delta) yield { type: "text_delta", text: delta };
        continue;
      }
      if (
        type === "response.reasoning_summary_text.delta" ||
        type === "response.reasoning_text.delta"
      ) {
        const delta = stringValue(event.delta);
        if (delta) yield { type: "thinking_delta", text: delta };
        continue;
      }

      if (type === "response.output_item.added") {
        const item = recordValue(event.item);
        if (item?.type === "function_call") {
          seedFunctionCall(calls, itemIndexes, event, item);
        }
        continue;
      }
      if (type === "response.function_call_arguments.delta") {
        const state = functionCallForEvent(calls, itemIndexes, event);
        const delta = stringValue(event.delta);
        if (delta) state.argumentsText += delta;
        continue;
      }
      if (type === "response.function_call_arguments.done") {
        const state = functionCallForEvent(calls, itemIndexes, event);
        const args = stringValue(event.arguments);
        if (args !== undefined) state.argumentsText = args;
        const call = completeFunctionCall(state);
        if (call) yield { type: "tool_calls", calls: [call] };
        continue;
      }
      if (type === "response.output_item.done") {
        const item = recordValue(event.item);
        if (item?.type === "function_call") {
          const state = seedFunctionCall(calls, itemIndexes, event, item);
          const call = completeFunctionCall(state);
          if (call) yield { type: "tool_calls", calls: [call] };
        }
        continue;
      }

      if (type === "response.completed" || type === "response.incomplete") {
        const responseValue = recordValue(event.response);
        if (responseValue) {
          for (const call of callsFromResponse(responseValue, calls, itemIndexes)) {
            yield { type: "tool_calls", calls: [call] };
          }
          const usage = readUsage(responseValue.usage);
          if (usage) yield { type: "usage", ...usage };
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
        throw responseFailure(event);
      }
      if (type === "error") {
        throw eventFailure(event);
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
}

function toResponsesRequest(student: ModelStudent, input: ModelInput): Record<string, unknown> {
  return {
    model: student.provider.model,
    instructions: student.agentConfig.systemPrompt,
    input: input.messages.flatMap(toResponsesInputItems),
    tools: input.tools.map(toResponsesTool),
    stream: true,
    store: false,
    ...(student.agentConfig.temperature !== undefined
      ? { temperature: student.agentConfig.temperature }
      : {}),
  };
}

function toResponsesTool(tool: ModelToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  };
}

function toResponsesInputItems(message: ModelMessage): Record<string, unknown>[] {
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

function responsesUrl(baseUrl: string): URL {
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

function functionCallForEvent(
  calls: Map<number, FunctionCallState>,
  itemIndexes: Map<string, number>,
  event: Record<string, unknown>,
): FunctionCallState {
  const index = outputIndex(event, itemIndexes);
  const current = calls.get(index) ?? {
    index,
    argumentsText: "",
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

function responseFailure(event: Record<string, unknown>): ModelProviderError {
  const response = recordValue(event.response);
  const error = recordValue(response?.error);
  const code = stringValue(error?.code);
  const message = stringValue(error?.message) ?? "Responses API 返回失败状态";
  return new ModelProviderError(
    "model_request_failed",
    `Responses API${code ? ` (${code})` : ""}: ${short(message, 300)}`,
    retryableCode(code),
  );
}

function eventFailure(event: Record<string, unknown>): ModelProviderError {
  const code = stringValue(event.code);
  const message = stringValue(event.message) ?? "Responses API 返回错误事件";
  return new ModelProviderError(
    "model_request_failed",
    `Responses API${code ? ` (${code})` : ""}: ${short(message, 300)}`,
    retryableCode(code),
  );
}

function retryableCode(code: string | undefined): boolean {
  if (!code) return false;
  return ["rate_limit_exceeded", "server_error", "service_unavailable", "timeout"].includes(code);
}

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

async function* readSse(body: ReadableStream<Uint8Array>): AsyncIterable<SseEvent> {
  let event: string | undefined;
  let data: string[] = [];

  for await (const line of readLines(body)) {
    if (line === "") {
      if (data.length > 0) {
        yield {
          ...(event ? { event } : {}),
          data: data.join("\n"),
        };
      }
      event = undefined;
      data = [];
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

async function* readLines(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let finished = false;

  try {
    while (true) {
      const part = await reader.read();
      if (part.done) {
        pending += decoder.decode();
        finished = true;
      } else {
        pending += decoder.decode(part.value, { stream: true });
      }

      while (true) {
        const separator = nextLineSeparator(pending, finished);
        if (!separator) break;
        yield pending.slice(0, separator.index);
        pending = pending.slice(separator.index + separator.length);
      }

      if (finished) break;
    }
    if (pending) yield pending;
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

async function readErrorBody(response: Response): Promise<string> {
  try {
    return short((await response.text()).trim(), 300);
  } catch {
    return "";
  }
}

function redact(value: string, token: string): string {
  return token ? value.split(token).join("[REDACTED]") : value;
}

function short(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
