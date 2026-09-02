import type { SessionResumeMeta, SessionResumeTextCursor } from "@kindergarten/contracts";
import type { ChatState, EntryCollection } from "./chat-types.js";

/** 从浏览器已经投影的当前 Turn 计算 resume 增量游标，不修改聊天状态。 */
export function sessionResumeMeta(chat: ChatState, turnId: string): SessionResumeMeta {
  const messages: Record<string, SessionResumeTextCursor> = {};
  const thoughts: Record<string, SessionResumeTextCursor> = {};
  collect(chat.historyChatEntries, chat, turnId, messages, thoughts);
  collect(chat.streamingChatEntries, chat, turnId, messages, thoughts);
  return { schemaVersion: 1, turnId, messages, thoughts };
}

/** 执行「collect」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function collect(
  entries: EntryCollection,
  chat: ChatState,
  turnId: string,
  messages: Record<string, SessionResumeTextCursor>,
  thoughts: Record<string, SessionResumeTextCursor>,
): void {
  for (const id of entries.order) {
    const entry = entries.byId[id];
    if (!entry || entry.turnId !== turnId) continue;
    if (entry.type === "message" && entry.messageId) {
      messages[entry.messageId] = cursor(entry.messageId, textLength(entry.content), chat, entry.modelAttemptId);
    } else if (entry.type === "thought") {
      thoughts[entry.messageId] = cursor(entry.messageId, textLength(entry.content), chat, entry.modelAttemptId);
    }
  }
}

/** 执行「cursor」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function cursor(messageId: string, length: number, chat: ChatState, modelAttemptId?: string): SessionResumeTextCursor {
  let nextChunkIndex = 0;
  for (const chunk of chat.streaming?.seenChunks ?? []) {
    const prefix = `${messageId}:${modelAttemptId ?? "legacy"}:`;
    if (!chunk.startsWith(prefix)) continue;
    const index = Number(chunk.slice(prefix.length));
    if (Number.isInteger(index)) nextChunkIndex = Math.max(nextChunkIndex, index + 1);
  }
  return {
    textLength: length,
    nextChunkIndex,
    ...(modelAttemptId ? { modelAttemptId } : {}),
  };
}

/** 执行「textLength」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function textLength(content: Array<{ type: string; text?: string }>): number {
  return content.reduce(/** 把当前元素归并到有限累加状态，避免额外复制完整集合。 */
(total, item) => total + (item.type === "text" && typeof item.text === "string" ? item.text.length : 0), 0);
}
