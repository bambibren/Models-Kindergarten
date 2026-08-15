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
import { ModelProviderError } from "./model-error.js";
import {
  assertContinuationTargetsStudent,
  readProviderOpaqueContinuation,
} from "./provider-continuation.js";

/** Ollama 是 V1 唯一面向用户的真实 Provider。 */
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
  constructor(readonly student: ModelStudent) {
    if (student.provider.kind !== "ollama") {
      throw new Error("OllamaProvider 只能接收 ollama ModelStudent");
    }
  }

  nativeReasoning(profile: ConcreteReasoningProfile): Record<string, boolean> {
    if (profile !== "fast" && profile !== "balanced") {
      throw new Error(`当前 Ollama ModelStudent 不支持推理档位: ${profile}`);
    }
    return { think: profile === "balanced" };
  }

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
        response.status === 429 || response.status >= 500,
      );
    }
    const value = await response.json() as unknown;
    const models = readModelNames(value);
    if (!models.has(this.student.provider.model)) {
      throw new ModelProviderError(
        "dependency_unavailable",
        `本地模型 ${this.student.provider.model} 未安装，请先运行 ollama pull ${this.student.provider.model}`,
        false,
      );
    }
  }

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
        value = fragment.messages.map((message) => toOllamaMessage(this.student, message));
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

  serializeInput(input: ModelInput): ModelContextSerialization {
    return {
      provider: "ollama",
      model: this.student.provider.model,
      format: "json",
      value: JSON.stringify(toOllamaRequest(this.student, input), null, 2),
    };
  }

  async *stream(input: ModelInput, signal: AbortSignal): AsyncIterable<ModelEvent> {
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
      );
    } catch (error) {
      if (isAbort(error) || signal.aborted) throw error;
      throw modelConnectionError(error, "Ollama 请求失败");
    }

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 240);
      throw new ModelProviderError(
        "model_request_failed",
        `Ollama 请求失败 (${response.status}): ${detail || response.statusText}`,
        response.status === 429 || response.status >= 500,
      );
    }
    if (!response.body) {
      throw new ModelProviderError("invalid_model_response", "Ollama 响应没有流式 Body", false);
    }

    for await (const line of readLines(response.body)) {
      const chunk = parseChunk(line);
      if (chunk.error) {
        throw new ModelProviderError("model_request_failed", `Ollama: ${chunk.error}`, false);
      }
      if (chunk.thinking) {
        yield { type: "thinking_delta", text: chunk.thinking };
      }
      if (chunk.text) yield { type: "text_delta", text: chunk.text };
      if (chunk.toolCalls.length > 0) {
        yield { type: "tool_calls", calls: chunk.toolCalls };
      }
      if (chunk.done) {
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

  private fetchWithResilience(
    url: URL,
    init?: RequestInit,
  ): Promise<Response> {
    return this.circuit.execute(() => withRetry(async () => {
      const response = await fetch(url, init);
      if (response.status === 429 || response.status >= 500) {
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
      ...input.messages.map((message) => toOllamaMessage(student, message)),
    ],
  };
}

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

function toOllamaSystemMessage(content: string): Record<string, unknown> {
  return { role: "system", content };
}

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
      tool_calls: message.toolCalls.map((call) => ({
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
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

function isTransientModelError(error: unknown): boolean {
  return error instanceof RetryableHttpError || error instanceof TypeError;
}

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

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

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

function readToolCalls(value: unknown): ModelToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
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

function readModelNames(value: unknown): Set<string> {
  if (!isRecord(value) || !Array.isArray(value.models)) return new Set();
  return new Set(
    value.models.flatMap((item) =>
      isRecord(item) && typeof item.name === "string" ? [item.name] : [],
    ),
  );
}

async function* readLines(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) yield line;
      }
      if (done) break;
    }
    if (pending.trim()) yield pending;
  } finally {
    reader.releaseLock();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
