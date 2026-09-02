import type {
  ConcreteReasoningProfile,
  ModelReasoningCapability,
} from "@kindergarten/contracts";
import type {
  ModelContextFragment,
  ModelContextSerialization,
  ModelEvent,
  ModelInput,
  ModelProvider,
  ModelStudent,
  ModelToolCall,
} from "./model-provider.js";
import { CircuitBreaker } from "../resilience/circuit-breaker.js";
import { withRetry } from "../resilience/retry.js";
import { isRetryableModelHttpStatus, ModelProviderError } from "./model-error.js";
import {
  assertContinuationTargetsStudent,
  readProviderOpaqueContinuation,
} from "./provider-continuation.js";

const MAX_OLLAMA_LINE_BYTES = 1024 * 1024;
const MAX_OLLAMA_STREAM_BYTES = 64 * 1024 * 1024;
const MAX_OLLAMA_JSON_BODY_BYTES = 1024 * 1024;
const MAX_OLLAMA_ERROR_BODY_BYTES = 64 * 1024;

/** Ollama 是 V1 唯一面向用户的真实 Provider。 */
/** 描述「OllamaProvider」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export class OllamaProvider implements ModelProvider {
  private readonly circuit = new CircuitBreaker("ollama");
  readonly reasoningCapability: ModelReasoningCapability = {
    schemaVersion: 1,
    control: "toggle",
    adjustable: true,
    supportedProfiles: ["fast", "balanced"],
    defaultProfile: "balanced",
    native: { parameter: "think", values: [false, true] },
  };
  /** 初始化「OllamaProvider」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(readonly student: ModelStudent) {
    if (student.provider.kind !== "ollama") {
      throw new Error("OllamaProvider 只能接收 ollama ModelStudent");
    }
  }

  /** 执行「nativeReasoning」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
nativeReasoning(profile: ConcreteReasoningProfile): Record<string, boolean> {
    if (profile !== "fast" && profile !== "balanced") {
      throw new Error(`当前 Ollama ModelStudent 不支持推理档位: ${profile}`);
    }
    return { think: profile === "balanced" };
  }

  /** 执行「verify」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async verify(): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchWithResilience(
        new URL("/api/tags", this.student.provider.baseUrl),
      );
    } catch (error) {
      throw modelConnectionError(error, "无法连接本地 Ollama 服务");
    }
    if (!response.ok) {
      throw new ModelProviderError(
        "dependency_unavailable",
        `Ollama 健康检查失败 (${response.status})`,
        isRetryableModelHttpStatus(response.status),
      );
    }
    const value = await readJsonAtMost(response, MAX_OLLAMA_JSON_BODY_BYTES, "模型目录");
    const models = readModelNames(value);
    if (!models.has(this.student.provider.model)) {
      throw new ModelProviderError(
        "dependency_unavailable",
        `本地模型 ${this.student.provider.model} 未安装，请先运行 ollama pull ${this.student.provider.model}`,
        false,
      );
    }
  }

  /** 执行「serializeContext」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
serializeContext(fragment: ModelContextFragment): ModelContextSerialization {
    let value: unknown;
    switch (fragment.kind) {
      case "system":
        value = toOllamaSystemMessage(fragment.content);
        break;
      case "tools":
        value = fragment.tools;
        break;
      case "messages":
        value = fragment.messages.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(message) => toOllamaMessage(this.student, message));
        break;
      case "omitted":
        value = { sent: false, sourceIds: fragment.sourceIds };
        break;
    }
    return {
      provider: "ollama",
      model: this.student.provider.model,
      format: "json",
      value: JSON.stringify(value, null, 2),
    };
  }

  /** 执行「serializeInput」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
serializeInput(input: ModelInput): ModelContextSerialization {
    return {
      provider: "ollama",
      model: this.student.provider.model,
      format: "json",
      value: JSON.stringify(toOllamaRequest(this.student, input), null, 2),
    };
  }

  /** 执行「stream」主流程，传播取消与失败并在结束时清理临时资源。 */
async *stream(
    input: ModelInput,
    signal: AbortSignal,
    onActivity?: () => void,
  ): AsyncIterable<ModelEvent> {
    let response: Response;
    try {
      response = await this.fetchWithResilience(
        new URL("/api/chat", this.student.provider.baseUrl),
        {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toOllamaRequest(this.student, input)),
        signal,
        },
        false,
      );
    } catch (error) {
      if (isAbort(error) || signal.aborted) throw error;
      throw modelConnectionError(error, "Ollama 请求失败");
    }

    if (!response.ok) {
      const detail = (await readTextAtMost(response, MAX_OLLAMA_ERROR_BODY_BYTES)).slice(0, 240);
      throw new ModelProviderError(
        "model_request_failed",
        `Ollama 请求失败 (${response.status}): ${detail || response.statusText}`,
        isRetryableModelHttpStatus(response.status),
      );
    }
    if (!response.body) {
      throw new ModelProviderError("invalid_model_response", "Ollama 响应没有流式 Body", false);
    }

    let itemSequence = 0;
    let activeTextItem: { id: string; kind: "reasoning" | "message"; text: string } | undefined;
    for await (const line of readLines(response.body)) {
      onActivity?.();
      const chunk = parseChunk(line);
      if (chunk.error) {
        throw new ModelProviderError("model_request_failed", `Ollama: ${chunk.error}`, false);
      }
      if (chunk.thinking) {
        if (activeTextItem?.kind !== "reasoning") {
          if (activeTextItem) {
            yield { type: "output_item_completed", item: { ...activeTextItem } };
          }
          activeTextItem = { id: `ollama:${itemSequence++}:reasoning`, kind: "reasoning", text: "" };
          yield { type: "output_item_started", item: { id: activeTextItem.id, kind: activeTextItem.kind } };
        }
        activeTextItem.text += chunk.thinking;
        yield {
          type: "output_item_delta",
          itemId: activeTextItem.id,
          delta: { kind: "text", text: chunk.thinking },
        };
      }
      if (chunk.text) {
        if (activeTextItem?.kind !== "message") {
          if (activeTextItem) {
            yield { type: "output_item_completed", item: { ...activeTextItem } };
          }
          activeTextItem = { id: `ollama:${itemSequence++}:message`, kind: "message", text: "" };
          yield { type: "output_item_started", item: { id: activeTextItem.id, kind: activeTextItem.kind } };
        }
        activeTextItem.text += chunk.text;
        yield {
          type: "output_item_delta",
          itemId: activeTextItem.id,
          delta: { kind: "text", text: chunk.text },
        };
      }
      if (chunk.toolCalls.length > 0) {
        if (activeTextItem) {
          yield { type: "output_item_completed", item: { ...activeTextItem } };
          activeTextItem = undefined;
        }
        for (const [index, rawCall] of chunk.toolCalls.entries()) {
          const itemId = `ollama:${itemSequence++}:tool:${index}`;
          const call = { ...rawCall, id: rawCall.id ?? itemId };
          yield {
            type: "output_item_started",
            item: { id: itemId, kind: "tool_call", callId: call.id, name: call.name },
          };
          yield { type: "output_item_completed", item: { id: itemId, kind: "tool_call", call } };
        }
      }
      if (chunk.done) {
        if (activeTextItem) {
          yield { type: "output_item_completed", item: { ...activeTextItem } };
          activeTextItem = undefined;
        }
        if (chunk.inputTokens !== undefined || chunk.outputTokens !== undefined) {
          yield {
            type: "usage",
            ...(chunk.inputTokens !== undefined
              ? { inputTokens: chunk.inputTokens }
              : {}),
            ...(chunk.outputTokens !== undefined
              ? { outputTokens: chunk.outputTokens }
              : {}),
          };
        }
        yield {
          type: "finish",
          reason: chunk.doneReason === "length" ? "length" : "stop",
        };
      }
    }
  }

  /** 读取「fetchWithResilience」所需数据，并遵守作用域、分页与容量边界。 */
private fetchWithResilience(
    url: URL,
    init?: RequestInit,
    retry = true,
  ): Promise<Response> {
    if (!retry) {
      // Runtime 已按 Model Attempt 统一重试；单次 Attempt 内不能再嵌套三次 HTTP 请求。
      return this.circuit.execute(() => fetch(url, init));
    }
    return this.circuit.execute(/** 读取「fetchWithResilience」所需数据，并遵守作用域、分页与容量边界。 */
() => withRetry(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
async () => {
      const response = await fetch(url, init);
      if (isRetryableModelHttpStatus(response.status)) {
        await response.body?.cancel();
        throw new RetryableHttpError(response.status);
      }
      return response;
    }, {
      maxAttempts: 3,
      initialDelayMs: 200,
      maxDelayMs: 1_500,
      jitter: true,
      shouldRetry: isTransientModelError,
    }, init?.signal instanceof AbortSignal ? init.signal : undefined));
  }
}

/** 根据已校验输入构建「toOllamaRequest」结果，不额外持有调用方的大对象。 */
function toOllamaRequest(student: ModelStudent, input: ModelInput): Record<string, unknown> {
  const think = ollamaThink(student, input);
  return {
    model: student.provider.model,
    stream: true,
    think,
    tools: input.tools,
    options: {
      ...(student.generationDefaults.temperature === undefined
        ? {}
        : { temperature: student.generationDefaults.temperature }),
    },
    messages: [
      toOllamaSystemMessage(input.systemPrompt),
      ...input.messages.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(message) => toOllamaMessage(student, message)),
    ],
  };
}

/** 执行「ollamaThink」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function ollamaThink(student: ModelStudent, input: ModelInput): boolean {
  if (input.reasoning === "disabled" || input.reasoning === undefined) {
    return input.reasoning !== "disabled";
  }
  if (
    input.reasoning.providerKind !== student.provider.kind ||
    input.reasoning.model !== student.provider.model
  ) {
    throw new ModelProviderError(
      "model_request_failed",
      "推理快照与当前 Ollama ModelStudent 不匹配",
      false,
    );
  }
  if (typeof input.reasoning.native.think !== "boolean") {
    throw new ModelProviderError(
      "model_request_failed",
      "Ollama 推理快照缺少 native.think",
      false,
    );
  }
  return input.reasoning.native.think;
}

/** 根据已校验输入构建「toOllamaSystemMessage」结果，不额外持有调用方的大对象。 */
function toOllamaSystemMessage(content: string): Record<string, unknown> {
  return { role: "system", content };
}

/** 根据已校验输入构建「toOllamaMessage」结果，不额外持有调用方的大对象。 */
function toOllamaMessage(student: ModelStudent, message: ModelInput["messages"][number]): Record<string, unknown> {
  if (message.providerOpaqueContinuation) {
    try {
      const continuation = readProviderOpaqueContinuation(message.providerOpaqueContinuation);
      assertContinuationTargetsStudent(continuation, student, "ollama");
    } catch (error) {
      throw new ModelProviderError(
        "invalid_model_response",
        "Provider continuation 与当前 Ollama ModelStudent 不匹配",
        false,
        { cause: error },
      );
    }
    throw new ModelProviderError(
      "invalid_model_response",
      "Ollama 不支持消费 Provider opaque continuation",
      false,
    );
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content,
      tool_calls: message.toolCalls.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(call) => ({
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content,
      ...(message.toolName ? { tool_name: message.toolName } : {}),
    };
  }
  return {
    role: message.role,
    content: message.content,
    ...(message.thinking ? { thinking: message.thinking } : {}),
  };
}

class RetryableHttpError extends Error {
  /** 初始化「RetryableHttpError」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/** 判断「isTransientModelError」对应条件，只返回判定结果且不修改输入状态。 */
function isTransientModelError(error: unknown): boolean {
  return error instanceof RetryableHttpError || error instanceof TypeError;
}

/** 执行「modelConnectionError」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function modelConnectionError(error: unknown, message: string): ModelProviderError {
  if (error instanceof ModelProviderError) return error;
  if (error instanceof RetryableHttpError) {
    return new ModelProviderError("model_request_failed", `${message} (HTTP ${error.status})`, true, { cause: error });
  }
  if (error instanceof TypeError || errorText(error).includes("熔断")) {
    return new ModelProviderError("dependency_unavailable", message, true, { cause: error });
  }
  return new ModelProviderError("model_request_failed", message, false, { cause: error });
}

/** 判断「isAbort」对应条件，只返回判定结果且不修改输入状态。 */
function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** 把未知异常转换为「errorText」文本，避免错误序列化过程再次抛出。 */
function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

interface ParsedChunk {
  text: string;
  thinking: string;
  toolCalls: ModelToolCall[];
  done: boolean;
  doneReason?: string;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
}

/** 校验并规范化「parseChunk」输入，非法数据直接返回明确错误。 */
function parseChunk(line: string): ParsedChunk {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch (error) {
    throw new ModelProviderError("invalid_model_response", "Ollama 返回了无效 JSON Chunk", false, { cause: error });
  }
  if (!isRecord(value)) {
    throw new ModelProviderError("invalid_model_response", "Ollama 返回了无效 JSON Chunk", false);
  }

  const message = value.message;
  return {
    text:
      isRecord(message) && typeof message.content === "string"
        ? message.content
        : "",
    thinking:
      isRecord(message) && typeof message.thinking === "string"
        ? message.thinking
        : "",
    toolCalls: isRecord(message) ? readToolCalls(message.tool_calls) : [],
    done: value.done === true,
    ...(typeof value.done_reason === "string"
      ? { doneReason: value.done_reason }
      : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
    ...(typeof value.prompt_eval_count === "number"
      ? { inputTokens: value.prompt_eval_count }
      : {}),
    ...(typeof value.eval_count === "number"
      ? { outputTokens: value.eval_count }
      : {}),
  };
}

/** 读取「readToolCalls」所需数据，并遵守作用域、分页与容量边界。 */
function readToolCalls(value: unknown): ModelToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(/** 读取「readToolCalls」所需数据，并遵守作用域、分页与容量边界。 */
(item) => {
    if (!isRecord(item) || !isRecord(item.function)) return [];
    const fn = item.function;
    if (typeof fn.name !== "string" || !isRecord(fn.arguments)) return [];
    return [{
      ...(typeof item.id === "string" ? { id: item.id } : {}),
      ...(typeof fn.index === "number" ? { index: fn.index } : {}),
      name: fn.name,
      arguments: fn.arguments,
    }];
  });
}

/** 读取「readModelNames」所需数据，并遵守作用域、分页与容量边界。 */
function readModelNames(value: unknown): Set<string> {
  if (!isRecord(value) || !Array.isArray(value.models)) return new Set();
  return new Set(
    value.models.flatMap(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(item) =>
      isRecord(item) && typeof item.name === "string" ? [item.name] : [],
    ),
  );
}

/** 读取「readLines」所需数据，并遵守作用域、分页与容量边界。 */
async function* readLines(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > MAX_OLLAMA_STREAM_BYTES) {
          await reader.cancel();
          throw ollamaSizeError("流", MAX_OLLAMA_STREAM_BYTES);
        }
      }
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (Buffer.byteLength(line, "utf8") > MAX_OLLAMA_LINE_BYTES) {
          await reader.cancel();
          throw ollamaSizeError("单行", MAX_OLLAMA_LINE_BYTES);
        }
        if (line.trim()) yield line;
      }
      if (Buffer.byteLength(pending, "utf8") > MAX_OLLAMA_LINE_BYTES) {
        await reader.cancel();
        throw ollamaSizeError("单行", MAX_OLLAMA_LINE_BYTES);
      }
      if (done) break;
    }
    if (pending.trim()) yield pending;
  } finally {
    reader.releaseLock();
  }
}

/** 读取「readJsonAtMost」所需数据，并遵守作用域、分页与容量边界。 */
async function readJsonAtMost(response: Response, maxBytes: number, scope: string): Promise<unknown> {
  const text = await readTextAtMost(response, maxBytes);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ModelProviderError("invalid_model_response", `Ollama ${scope}不是有效 JSON`, false, { cause: error });
  }
}

/** 读取「readTextAtMost」所需数据，并遵守作用域、分页与容量边界。 */
async function readTextAtMost(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    await response.body.cancel();
    throw ollamaSizeError("响应", maxBytes);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw ollamaSizeError("响应", maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** 执行「ollamaSizeError」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function ollamaSizeError(scope: string, maxBytes: number): ModelProviderError {
  return new ModelProviderError(
    "invalid_model_response",
    `Ollama ${scope}超过 ${maxBytes} 字节资源上限`,
    false,
  );
}

/** 判断「isRecord」对应条件，只返回判定结果且不修改输入状态。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
