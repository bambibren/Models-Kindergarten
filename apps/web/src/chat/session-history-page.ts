import type { TokenUsageComponent } from "@kindergarten/contracts";
import type { SessionTurnPage } from "../api/control-api.js";
import type { ChatEntry, EntryCollection } from "./chat-types.js";
import { emptyEntries } from "./chat-types.js";

/** 把只读历史页转换成与 ACP 实时消息相同的 Web 聊天投影。 */
export function projectSessionTurnPage(page: SessionTurnPage): EntryCollection {
  let collection = emptyEntries();
  for (const turn of page.turns) {
    for (const entry of turn.entries) {
      if (entry.type === "message") {
        collection = upsert(collection, {
          type: "message",
          id: `message:${entry.messageId}`,
          messageId: entry.messageId,
          turnId: entry.turnId,
          role: entry.role,
          content: [{ type: "text", text: entry.text }],
          status: "done",
          ...(entry.artifactMentions?.length ? { artifactMentions: entry.artifactMentions } : {}),
        });
      } else if (entry.type === "thought") {
        collection = upsert(collection, {
          type: "thought",
          id: `thought:${entry.messageId}`,
          messageId: entry.messageId,
          turnId: entry.turnId,
          content: [{ type: "text", text: entry.text }],
          status: "done",
        });
      } else if (entry.type === "tool_call") {
        collection = upsert(collection, {
          type: "tool_call",
          id: `tool:${entry.toolCallId}`,
          toolCallId: entry.toolCallId,
          turnId: entry.turnId,
          title: entry.title,
          name: entry.name,
          kind: entry.kind,
          status: entry.status,
          rawInput: entry.rawInput,
          ...(entry.rawOutput !== undefined ? { rawOutput: entry.rawOutput } : {}),
          content: structuredClone(entry.content),
          locations: structuredClone(entry.locations),
        });
      } else if (entry.type === "context_summary") {
        collection = upsert(collection, {
          type: "context_summary",
          id: `context:${entry.summary.turnId}`,
          turnId: entry.turnId,
          summary: structuredClone(entry.summary),
        });
      } else if (entry.type === "context_window_usage") {
        collection = upsert(collection, {
          type: "context_window_usage",
          id: `context-window:${entry.state.afterTurnId}`,
          turnId: entry.turnId,
          state: structuredClone(entry.state),
        });
      } else {
        for (const component of entry.usage.components) collection = applyTokenEstimate(collection, component);
        collection = upsert(collection, {
          type: "token_usage",
          id: `usage:${entry.usage.turnId}`,
          turnId: entry.turnId,
          usage: structuredClone(entry.usage),
        });
      }
    }
  }
  return collection;
}

/** 分页投影使用稳定 ID 去重，避免首屏 ACP 回放与 Control 页重叠时出现重复气泡。 */
function upsert(collection: EntryCollection, entry: ChatEntry): EntryCollection {
  const exists = collection.byId[entry.id] !== undefined;
  return {
    order: exists ? collection.order : [...collection.order, entry.id],
    byId: { ...collection.byId, [entry.id]: entry },
  };
}

/** 恢复历史页中按目标记录的 Token 估算。 */
function applyTokenEstimate(collection: EntryCollection, component: TokenUsageComponent): EntryCollection {
  const prefix = component.targetType === "message" ? "message" : component.targetType === "thought" ? "thought" : "tool";
  const id = `${prefix}:${component.targetId}`;
  const entry = collection.byId[id];
  if (!entry || entry.type === "context_summary" || entry.type === "token_usage" || entry.type === "context_window_usage") return collection;
  return upsert(collection, { ...entry, tokenEstimate: component });
}
