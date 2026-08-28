import type { ContentBlock, SessionNotification, ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk";
import {
  PRODUCT_CONFIG,
  readMessageMeta,
  type ContextSummaryNotification,
  type ContextWindowUsageNotification,
  type TokenUsageComponent,
  type TokenUsageNotification,
} from "@kindergarten/contracts";
import type { ArtifactMention } from "@kindergarten/contracts";
import type { ChatEntry, ChatState, EntryCollection, MessageEntry, StreamSource, ThoughtEntry, ToolCallEntry } from "./chat-types.js";
import { emptyEntries } from "./chat-types.js";

/** 描述「ChatAction」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ChatAction =
  | { type: "session/open"; sessionId: string }
  | { type: "history/prepend"; entries: EntryCollection; maxTurns: number }
  | { type: "stream/start"; operationId: string; source: StreamSource; turnId: string; optimisticContent?: ContentBlock[]; optimisticArtifactMentions?: ArtifactMention[] }
  | { type: "stream/load-complete"; operationId: string; activeTurn?: { operationId: string; turnId: string } }
  | { type: "stream/commit"; operationId: string }
  | { type: "context/summary"; value: ContextSummaryNotification }
  | { type: "token/usage"; value: TokenUsageNotification }
  | { type: "context-window/usage"; value: ContextWindowUsageNotification }
  | { type: "acp/update"; value: SessionNotification };

export const emptyChat: ChatState = {
  sessionId: null,
  historyChatEntries: emptyEntries(),
  streamingChatEntries: emptyEntries(),
  streaming: null,
};

/** ACP Chat Assembler：只负责把 SessionUpdate 归约为稳定的 ChatEntry。 */
/** 根据动作归并「chatReducer」状态，保持纯函数、幂等与终态不可倒退。 */
export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  if (action.type === "session/open") {
    return { sessionId: action.sessionId, historyChatEntries: emptyEntries(), streamingChatEntries: emptyEntries(), streaming: null };
  }
  if (action.type === "history/prepend") {
    return {
      ...state,
      historyChatEntries: prependHistory(state.historyChatEntries, action.entries, action.maxTurns),
    };
  }
  if (action.type === "stream/start") {
    const optimistic = action.optimisticContent
      ? optimisticMessage(action.operationId, action.turnId, action.optimisticContent, action.optimisticArtifactMentions)
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
  if (action.type === "stream/load-complete") {
    if (state.streaming?.operationId !== action.operationId) return state;
    const split = action.activeTurn
      ? partitionCollection(state.streamingChatEntries, action.activeTurn.turnId)
      : { matching: emptyEntries(), rest: state.streamingChatEntries };
    return {
      ...state,
      historyChatEntries: retainLatestTurns(
        mergeCollections(state.historyChatEntries, split.rest),
        PRODUCT_CONFIG.agent.maxWebRetainedTurns,
      ),
      streamingChatEntries: split.matching,
      streaming: action.activeTurn ? {
        operationId: action.activeTurn.operationId,
        source: "load",
        turnId: action.activeTurn.turnId,
        seenChunks: new Set(),
      } : null,
    };
  }
  if (action.type === "stream/commit") {
    if (state.streaming?.operationId !== action.operationId) return state;
    return {
      ...state,
      historyChatEntries: retainLatestTurns(
        mergeCollections(state.historyChatEntries, state.streamingChatEntries),
        PRODUCT_CONFIG.agent.maxWebRetainedTurns,
      ),
      streamingChatEntries: emptyEntries(),
      streaming: null,
    };
  }
  if (action.type === "context/summary") {
    if (action.value.sessionId !== state.sessionId || !state.streaming) return state;
    const summary = action.value.summary;
    return {
      ...state,
      streamingChatEntries: upsert(state.streamingChatEntries, {
        type: "context_summary",
        id: `context:${summary.turnId}`,
        turnId: summary.turnId,
        summary,
      }),
    };
  }
  if (action.type === "token/usage") {
    if (action.value.sessionId !== state.sessionId || !state.streaming) return state;
    const usage = action.value.usage;
    let collection = state.streamingChatEntries;
    for (const component of usage.components) {
      collection = applyTokenEstimate(collection, component);
    }
    collection = upsert(collection, {
      type: "token_usage",
      id: `usage:${usage.turnId}`,
      turnId: usage.turnId,
      usage,
    });
    return { ...state, streamingChatEntries: collection };
  }
  if (action.type === "context-window/usage") {
    if (action.value.sessionId !== state.sessionId || !state.streaming) return state;
    const value = action.value.state;
    return {
      ...state,
      streamingChatEntries: upsert(state.streamingChatEntries, {
        type: "context_window_usage",
        id: `context-window:${value.afterTurnId}`,
        turnId: value.afterTurnId,
        state: value,
      }),
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

/** 较旧页放到现有历史之前，并只保留最新的固定数量 Turn。 */
function prependHistory(current: EntryCollection, older: EntryCollection, maxTurns: number): EntryCollection {
  const order = [
    ...older.order.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(id) => current.byId[id] === undefined),
    ...current.order,
  ];
  const byId = { ...older.byId, ...current.byId };
  return retainLatestTurns({ order, byId }, maxTurns);
}

/** 从集合尾部保留最新 Turn，同时整组删除同一 Turn 的所有投影条目。 */
function retainLatestTurns(collection: EntryCollection, maxTurns: number): EntryCollection {
  const turnOrder: string[] = [];
  const seenTurns = new Set<string>();
  for (const id of collection.order) {
    const turnId = collection.byId[id]?.turnId;
    if (turnId && !seenTurns.has(turnId)) {
      seenTurns.add(turnId);
      turnOrder.push(turnId);
    }
  }
  const retainedTurns = new Set(turnOrder.slice(-Math.max(0, maxTurns)));
  const retainedOrder = collection.order.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(id) => {
    const turnId = collection.byId[id]?.turnId;
    return turnId !== undefined && retainedTurns.has(turnId);
  });
  return {
    order: retainedOrder,
    byId: Object.fromEntries(retainedOrder.flatMap(/** 由规范字段生成稳定的「byId」标识，供索引精确定位且不保留原始大对象。 */
(id) => collection.byId[id] ? [[id, collection.byId[id]]] : [])),
  };
}

/** 执行「reduceMessage」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
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
        ...(meta.artifactMentions ? { artifactMentions: meta.artifactMentions } : {}),
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
      ...(meta.artifactMentions ? { artifactMentions: meta.artifactMentions } : {}),
    });
  } else if (current.type === "message") {
    collection = upsert(collection, {
      ...current,
      content: appendContent(current.content, content),
      status: meta.final ? "done" : current.status,
      ...(meta.artifactMentions ? { artifactMentions: meta.artifactMentions } : {}),
    });
  }
  return { ...state, streamingChatEntries: collection, streaming };
}

/** 执行「reduceThought」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
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

/** 执行「reduceTool」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function reduceTool(state: ChatState, update: ToolCall | ToolCallUpdate, creating: boolean): ChatState {
  if (!state.streaming) return state;
  const id = `tool:${update.toolCallId}`;
  const current = state.streamingChatEntries.byId[id];
  const base = current?.type === "tool_call" ? current : toolPlaceholder(state.streaming.turnId, update.toolCallId);
  return { ...state, streamingChatEntries: upsert(state.streamingChatEntries, patchTool(base, update, creating)) };
}

/** 执行「patchTool」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
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

/** 执行「optimisticMessage」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function optimisticMessage(operationId: string, turnId: string, content: ContentBlock[], artifactMentions?: ArtifactMention[]): MessageEntry {
  return { type: "message", id: `optimistic:${operationId}`, messageId: null, turnId, role: "user", content, status: "done", ...(artifactMentions?.length ? { artifactMentions } : {}) };
}

/** 根据已校验输入构建「toolPlaceholder」结果，不额外持有调用方的大对象。 */
function toolPlaceholder(turnId: string, toolCallId: string): ToolCallEntry {
  return { type: "tool_call", id: `tool:${toolCallId}`, toolCallId, turnId, title: "工具调用", kind: "other", status: "pending", content: [], locations: [] };
}

/** 执行「collectionOf」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function collectionOf(entry: ChatEntry): EntryCollection { return { order: [entry.id], byId: { [entry.id]: entry } }; }

/** 执行「upsert」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function upsert(collection: EntryCollection, entry: ChatEntry): EntryCollection {
  const exists = collection.byId[entry.id] !== undefined;
  return { order: exists ? collection.order : [...collection.order, entry.id], byId: { ...collection.byId, [entry.id]: entry } };
}

/** 由规范字段生成稳定的「replaceId」标识，供索引精确定位且不保留原始大对象。 */
function replaceId(collection: EntryCollection, oldId: string, newId: string, entry: ChatEntry): EntryCollection {
  const byId = { ...collection.byId };
  delete byId[oldId];
  byId[newId] = entry;
  return { order: collection.order.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(id) => id === oldId ? newId : id), byId };
}

/** 汇总「mergeCollections」对应指标，保持缺失字段语义且不重复计算同一来源。 */
function mergeCollections(committed: EntryCollection, streaming: EntryCollection): EntryCollection {
  const byId = { ...committed.byId };
  for (const id of streaming.order) {
    const entry = streaming.byId[id];
    if (entry) byId[id] = finalizeEntry(entry);
  }
  return { order: [...committed.order, ...streaming.order.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(id) => committed.byId[id] === undefined)], byId };
}

/** 执行「partitionCollection」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function partitionCollection(collection: EntryCollection, turnId: string): { matching: EntryCollection; rest: EntryCollection } {
  const matching = emptyEntries();
  const rest = emptyEntries();
  for (const id of collection.order) {
    const entry = collection.byId[id];
    if (!entry) continue;
    const target = entry.turnId === turnId ? matching : rest;
    target.order.push(id);
    target.byId[id] = entry;
  }
  return { matching, rest };
}

/** 执行「finalizeEntry」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function finalizeEntry(entry: ChatEntry): ChatEntry {
  if (
    entry.type === "tool_call" ||
    entry.type === "context_summary" ||
    entry.type === "token_usage" ||
    entry.type === "context_window_usage"
  ) return entry;
  return { ...entry, status: "done" } as MessageEntry | ThoughtEntry;
}

/** 执行「applyTokenEstimate」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function applyTokenEstimate(
  collection: EntryCollection,
  component: TokenUsageComponent,
): EntryCollection {
  if (component.targetType === "message") {
    const entry = collection.byId[`message:${component.targetId}`];
    return entry?.type === "message"
      ? upsert(collection, { ...entry, tokenEstimate: component })
      : collection;
  }
  if (component.targetType === "thought") {
    const entry = collection.byId[`thought:${component.targetId}`];
    return entry?.type === "thought"
      ? upsert(collection, { ...entry, tokenEstimate: component })
      : collection;
  }
  const entry = collection.byId[`tool:${component.targetId}`];
  return entry?.type === "tool_call"
    ? upsert(collection, { ...entry, tokenEstimate: component })
    : collection;
}

/** 更新「appendContent」对应状态，并保持写入顺序、原子性与容量约束。 */
function appendContent(current: ContentBlock[], next: ContentBlock): ContentBlock[] {
  if (isEmptyText(next)) return current;
  const result = [...current];
  const last = result.at(-1);
  if (last?.type === "text" && next.type === "text") result[result.length - 1] = { ...last, text: last.text + next.text };
  else result.push(next);
  return result;
}

/** 执行「textOf」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function textOf(content: ContentBlock[]): string { return content.flatMap(/** 执行「join」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(item) => item.type === "text" ? [item.text] : []).join(""); }
/** 判断「isEmptyText」对应条件，只返回判定结果且不修改输入状态。 */
function isEmptyText(content: ContentBlock): boolean { return content.type === "text" && content.text.length === 0; }
/** 执行「addSeen」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function addSeen(streaming: ChatState["streaming"] & {}, value: string) {
  const seenChunks = new Set(streaming.seenChunks); seenChunks.add(value); return { ...streaming, seenChunks };
}
