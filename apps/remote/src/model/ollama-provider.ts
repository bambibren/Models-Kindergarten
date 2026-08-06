import type {
  ModelEvent,
  ModelInput,
  ModelProvider,
  ModelStudent,
  ModelToolCall,
} from "./model-provider.js";

/** Ollama 是 V1 唯一面向用户的真实 Provider。 */
export class OllamaProvider implements ModelProvider {
  constructor(readonly student: ModelStudent) {
    if (student.provider.kind !== "ollama") {
      throw new Error("OllamaProvider 只能接收 ollama ModelStudent");
    }
  }

  async verify(): Promise<void> {
    const response = await fetch(new URL("/api/tags", this.student.provider.baseUrl));
    if (!response.ok) {
      throw new Error(`Ollama 健康检查失败 (${response.status})`);
    }
    const value = await response.json() as unknown;
    const models = readModelNames(value);
    if (!models.has(this.student.provider.model)) {
      throw new Error(
        `本地模型 ${this.student.provider.model} 未安装，请先运行 ollama pull ${this.student.provider.model}`,
      );
    }
  }

  async *stream(input: ModelInput, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const response = await fetch(
      new URL("/api/chat", this.student.provider.baseUrl),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.student.provider.model,
          stream: true,
          think: true,
          tools: input.tools,
          options: {
            temperature: this.student.agentConfig.temperature ?? 0.4,
          },
          messages: [
            {
              role: "system",
              content: this.student.agentConfig.systemPrompt,
            },
            ...input.messages,
          ],
        }),
        signal,
      },
    );

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 240);
      throw new Error(
        `Ollama 请求失败 (${response.status}): ${detail || response.statusText}`,
      );
    }
    if (!response.body) throw new Error("Ollama 响应没有流式 Body");

    for await (const line of readLines(response.body)) {
      const chunk = parseChunk(line);
      if (chunk.error) throw new Error(`Ollama: ${chunk.error}`);
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
        yield { type: "finish", reason: "stop" };
      }
    }
  }
}

interface ParsedChunk {
  text: string;
  thinking: string;
  toolCalls: ModelToolCall[];
  done: boolean;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
}

function parseChunk(line: string): ParsedChunk {
  const value = JSON.parse(line) as unknown;
  if (!isRecord(value)) throw new Error("Ollama 返回了无效 JSON Chunk");

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
