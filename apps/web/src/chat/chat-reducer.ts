import type { ContentBlock, SessionNotification, ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk";
import { readMessageMeta } from "@kindergarten/contracts";
import type { ChatEntry, ChatState, EntryCollection, MessageEntry, StreamSource, ThoughtEntry, ToolCallEntry } from "./chat-types.js";
import { emptyEntries } from "./chat-types.js";

export type ChatAction =
  | { type: "session/open"; sessionId: string }
  | { type: "stream/start"; operationId: string; source: StreamSource; turnId: string; optimisticContent?: ContentBlock[] }
  | { type: "stream/commit"; operationId: string }
  | { type: "acp/update"; value: SessionNotification };

export const emptyChat: ChatState = {
  sessionId: null,
  historyChatEntries: emptyEntries(),
  streamingChatEntries: emptyEntries(),
  streaming: null,
};

/** ACP Chat Assembler：只负责把 SessionUpdate 归约为稳定的 ChatEntry。 */
export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  if (action.type === "session/open") {
    return { sessionId: action.sessionId, historyChatEntries: emptyEntries(), streamingChatEntries: emptyEntries(), streaming: null };
  }
  if (action.type === "stream/start") {
    const optimistic = action.optimisticContent
      ? optimisticMessage(action.operationId, action.turnId, action.optimisticContent)
      : undefined;
    return {
      ...state,
      streamingChatEntries: optimistic ? collectionOf(optimistic) : emptyEntries(),
      streaming: {
        operationId: action.operationId,
        source: action.source,
        turnId: action.turnId,
        seenChunks: new Set(),
        ...(optimistic ? { optimisticUserEntryId: optimistic.id } : {}),
      },
    };
  }
  if (action.type === "stream/commit") {
    if (state.streaming?.operationId !== action.operationId) return state;
    return {
      ...state,
      historyChatEntries: mergeCollections(state.historyChatEntries, state.streamingChatEntries),
      streamingChatEntries: emptyEntries(),
      streaming: null,
    };
  }
  if (action.value.sessionId !== state.sessionId || !state.streaming) return state;
  const update = action.value.update;
  switch (update.sessionUpdate) {
    case "user_message_chunk": return reduceMessage(state, "user", update.messageId, update.content, update._meta);
    case "agent_message_chunk": return reduceMessage(state, "assistant", update.messageId, update.content, update._meta);
    case "agent_thought_chunk": return reduceThought(state, update.messageId, update.content, update._meta);
    case "tool_call": return reduceTool(state, update, true);
    case "tool_call_update": return reduceTool(state, update, false);
    default: return state;
  }
}

function reduceMessage(state: ChatState, role: MessageEntry["role"], messageId: string | null | undefined, content: ContentBlock, rawMeta: unknown): ChatState {
  if (!messageId || !state.streaming) return state;
  const meta = readMessageMeta(rawMeta);
  if (!meta) return state;
  const chunk = `${messageId}:${meta.chunkIndex}`;
  if (state.streaming.seenChunks.has(chunk)) return state;
  let collection = state.streamingChatEntries;
  let streaming = addSeen(state.streaming, chunk);
  const id = `message:${messageId}`;
  const current = collection.byId[id];

  if (!current && role === "user" && streaming.source === "prompt" && streaming.optimisticUserEntryId) {
    const optimistic = collection.byId[streaming.optimisticUserEntryId];
    if (optimistic?.type === "message") {
      collection = replaceId(collection, optimistic.id, id, {
        ...optimistic, id, messageId,
        content: textOf([content]) === textOf(optimistic.content) ? optimistic.content : [content],
        status: meta.final ? "done" : "streaming",
      });
      streaming = { ...streaming, optimisticUserEntryId: id };
      return { ...state, streamingChatEntries: collection, streaming };
    }
  }

  if (!current) {
    if (isEmptyText(content) && meta.final) return { ...state, streaming };
    collection = upsert(collection, {
      type: "message", id, messageId, turnId: meta.turnId, role,
      content: [content], status: meta.final ? "done" : "streaming",
    });
  } else if (current.type === "message") {
    collection = upsert(collection, {
      ...current,
      content: appendContent(current.content, content),
      status: meta.final ? "done" : current.status,
    });
  }
  return { ...state, streamingChatEntries: collection, streaming };
}

function reduceThought(state: ChatState, messageId: string | null | undefined, content: ContentBlock, rawMeta: unknown): ChatState {
  if (!messageId || !state.streaming) return state;
  const meta = readMessageMeta(rawMeta);
  if (!meta) return state;
  const chunk = `${messageId}:${meta.chunkIndex}`;
  if (state.streaming.seenChunks.has(chunk)) return state;
  const streaming = addSeen(state.streaming, chunk);
  const id = `thought:${messageId}`;
  const current = state.streamingChatEntries.byId[id];
  let collection = state.streamingChatEntries;
  if (!current) {
    if (isEmptyText(content) && meta.final) return { ...state, streaming };
    collection = upsert(collection, {
      type: "thought", id, messageId, turnId: meta.turnId,
      content: [content], status: meta.final ? "done" : "streaming",
    });
  } else if (current.type === "thought") {
    collection = upsert(collection, {
      ...current, content: appendContent(current.content, content),
      status: meta.final ? "done" : current.status,
    });
  }
  return { ...state, streamingChatEntries: collection, streaming };
}

function reduceTool(state: ChatState, update: ToolCall | ToolCallUpdate, creating: boolean): ChatState {
  if (!state.streaming) return state;
  const id = `tool:${update.toolCallId}`;
  const current = state.streamingChatEntries.byId[id];
  const base = current?.type === "tool_call" ? current : toolPlaceholder(state.streaming.turnId, update.toolCallId);
  return { ...state, streamingChatEntries: upsert(state.streamingChatEntries, patchTool(base, update, creating)) };
}

function patchTool(current: ToolCallEntry, update: ToolCall | ToolCallUpdate, creating: boolean): ToolCallEntry {
  return {
    ...current,
    ...(update.title != null ? { title: update.title } : {}),
    ...(update.name != null ? { name: update.name } : {}),
    ...(update.kind != null ? { kind: update.kind } : {}),
    ...(update.status != null ? { status: update.status } : creating ? { status: "pending" } : {}),
    ...(update.content !== undefined ? { content: update.content ?? [] } : {}),
    ...(update.locations !== undefined ? { locations: update.locations ?? [] } : {}),
    ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
    ...(update.rawOutput !== undefined ? { rawOutput: update.rawOutput } : {}),
  };
}

function optimisticMessage(operationId: string, turnId: string, content: ContentBlock[]): MessageEntry {
  return { type: "message", id: `optimistic:${operationId}`, messageId: null, turnId, role: "user", content, status: "done" };
}

function toolPlaceholder(turnId: string, toolCallId: string): ToolCallEntry {
  return { type: "tool_call", id: `tool:${toolCallId}`, toolCallId, turnId, title: "工具调用", kind: "other", status: "pending", content: [], locations: [] };
}

function collectionOf(entry: ChatEntry): EntryCollection { return { order: [entry.id], byId: { [entry.id]: entry } }; }

function upsert(collection: EntryCollection, entry: ChatEntry): EntryCollection {
  const exists = collection.byId[entry.id] !== undefined;
  return { order: exists ? collection.order : [...collection.order, entry.id], byId: { ...collection.byId, [entry.id]: entry } };
}

function replaceId(collection: EntryCollection, oldId: string, newId: string, entry: ChatEntry): EntryCollection {
  const byId = { ...collection.byId };
  delete byId[oldId];
  byId[newId] = entry;
  return { order: collection.order.map((id) => id === oldId ? newId : id), byId };
}

function mergeCollections(committed: EntryCollection, streaming: EntryCollection): EntryCollection {
  const byId = { ...committed.byId };
  for (const id of streaming.order) {
    const entry = streaming.byId[id];
    if (entry) byId[id] = finalizeEntry(entry);
  }
  return { order: [...committed.order, ...streaming.order.filter((id) => committed.byId[id] === undefined)], byId };
}

function finalizeEntry(entry: ChatEntry): ChatEntry {
  return entry.type === "tool_call" ? entry : { ...entry, status: "done" } as MessageEntry | ThoughtEntry;
}

function appendContent(current: ContentBlock[], next: ContentBlock): ContentBlock[] {
  if (isEmptyText(next)) return current;
  const result = [...current];
  const last = result.at(-1);
  if (last?.type === "text" && next.type === "text") result[result.length - 1] = { ...last, text: last.text + next.text };
  else result.push(next);
  return result;
}

function textOf(content: ContentBlock[]): string { return content.flatMap((item) => item.type === "text" ? [item.text] : []).join(""); }
function isEmptyText(content: ContentBlock): boolean { return content.type === "text" && content.text.length === 0; }
function addSeen(streaming: ChatState["streaming"] & {}, value: string) {
  const seenChunks = new Set(streaming.seenChunks); seenChunks.add(value); return { ...streaming, seenChunks };
}
