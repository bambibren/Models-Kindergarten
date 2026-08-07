import type { ModelMessage, ModelToolCall } from "../model/model-provider.js";
import type { SessionEntry, SessionToolCallEntry } from "../repository/session-types.js";

const DEFAULT_MAX_MESSAGES = 80;

/** 从 Session 事实生成模型上下文；UI ChatEntry 不参与这个过程。 */
export class ContextBuilder {
  constructor(private readonly maxMessages = DEFAULT_MAX_MESSAGES) {}

  build(sessionEntries: SessionEntry[], prompt: string): ModelMessage[] {
    const messages: ModelMessage[] = [];
    for (let index = 0; index < sessionEntries.length; index += 1) {
      const entry = sessionEntries[index];
      if (!entry || entry.type === "thought") continue;
      if (entry.type === "message") {
        messages.push({ role: entry.role, content: entry.text });
        continue;
      }

      const group: SessionToolCallEntry[] = [entry];
      while (sessionEntries[index + 1]?.type === "tool_call") {
        group.push(sessionEntries[index + 1] as SessionToolCallEntry);
        index += 1;
      }
      const completed = group.filter((item) => item.modelContent !== undefined);
      if (completed.length === 0) continue;
      messages.push({
        role: "assistant",
        content: "",
        toolCalls: completed.map(toModelToolCall),
      });
      for (const tool of completed) {
        messages.push({
          role: "tool",
          content: tool.modelContent ?? "",
          toolName: tool.name,
          toolCallId: tool.toolCallId,
        });
      }
    }

    messages.push({ role: "user", content: prompt });
    if (messages.length <= this.maxMessages) return messages;
    let start = messages.length - this.maxMessages;
    while (start > 0 && messages[start]?.role === "tool") start -= 1;
    return messages.slice(start);
  }
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
