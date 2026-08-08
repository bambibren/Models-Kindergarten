import type { ModelMessage, ModelToolCall } from "../model/model-provider.js";
import type { SessionEntry, SessionToolCallEntry } from "../repository/session-types.js";
import type { ContextMessageObservation } from "@kindergarten/runtime-observation";

const DEFAULT_MAX_MESSAGES = 80;

export interface ContextBuildResult {
  messages: ModelMessage[];
  observations: ContextMessageObservation[];
  truncatedSourceIds: string[];
}

/** 从 Session 事实生成模型上下文；UI ChatEntry 不参与这个过程。 */
export class ContextBuilder {
  constructor(private readonly maxMessages = DEFAULT_MAX_MESSAGES) {}

  build(sessionEntries: SessionEntry[], prompt: string): ModelMessage[] {
    return this.buildObserved(sessionEntries, prompt).messages;
  }

  /** 同一次投影同时生成模型消息和来源说明，避免评测层反向猜测上下文来源。 */
  buildObserved(sessionEntries: SessionEntry[], prompt: string): ContextBuildResult {
    const items: Array<{
      message: ModelMessage;
      observation: ContextMessageObservation;
    }> = [];
    for (let index = 0; index < sessionEntries.length; index += 1) {
      const entry = sessionEntries[index];
      if (!entry || entry.type === "thought") continue;
      if (entry.type === "message") {
        const message = { role: entry.role, content: entry.text } satisfies ModelMessage;
        items.push({
          message,
          observation: observation(message, "session_history", entry.messageId),
        });
        continue;
      }

      const group: SessionToolCallEntry[] = [entry];
      while (sessionEntries[index + 1]?.type === "tool_call") {
        group.push(sessionEntries[index + 1] as SessionToolCallEntry);
        index += 1;
      }
      const completed = group.filter((item) => item.modelContent !== undefined);
      if (completed.length === 0) continue;
      const assistant = {
        role: "assistant",
        content: "",
        toolCalls: completed.map(toModelToolCall),
      } satisfies ModelMessage;
      items.push({
        message: assistant,
        observation: observation(
          assistant,
          "session_history",
          `tool-group:${completed[0]?.toolCallId ?? index}`,
        ),
      });
      for (const tool of completed) {
        const message = {
          role: "tool",
          content: tool.modelContent ?? "",
          toolName: tool.name,
          toolCallId: tool.toolCallId,
        } satisfies ModelMessage;
        items.push({
          message,
          observation: observation(message, "tool_result", tool.toolCallId),
        });
      }
    }

    const current = { role: "user", content: prompt } satisfies ModelMessage;
    items.push({
      message: current,
      observation: observation(current, "current_turn", "current-prompt"),
    });
    if (items.length <= this.maxMessages) {
      return {
        messages: items.map((item) => item.message),
        observations: items.map((item) => item.observation),
        truncatedSourceIds: [],
      };
    }
    let start = items.length - this.maxMessages;
    while (start > 0 && items[start]?.message.role === "tool") start -= 1;
    return {
      messages: items.slice(start).map((item) => item.message),
      observations: items.slice(start).map((item) => item.observation),
      truncatedSourceIds: [...new Set(
        items.slice(0, start).flatMap((item) => item.observation.sourceId ?? []),
      )],
    };
  }
}

export function observeMessage(
  message: ModelMessage,
  source: ContextMessageObservation["source"],
  sourceId?: string,
): ContextMessageObservation {
  return observation(message, source, sourceId);
}

function toModelToolCall(entry: SessionToolCallEntry): ModelToolCall {
  return {
    id: entry.toolCallId,
    name: entry.name,
    arguments: isRecord(entry.rawInput) ? entry.rawInput : {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function observation(
  message: ModelMessage,
  source: ContextMessageObservation["source"],
  sourceId?: string,
): ContextMessageObservation {
  const serialized = [
    message.content,
    message.thinking ?? "",
    message.toolCalls ? JSON.stringify(message.toolCalls) : "",
  ].join("");
  return {
    role: message.role,
    source,
    ...(sourceId ? { sourceId } : {}),
    content: serialized,
    // 精确 Token 最终采用 Provider usage；这里仅用于逐项解释上下文组成。
    estimatedTokens: Math.max(1, Math.ceil(serialized.length / 4)),
  };
}
