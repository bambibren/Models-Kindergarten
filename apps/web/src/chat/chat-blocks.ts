import type { ChatEntry, EntryCollection, EntryId } from "./chat-types.js";

export type ChatBlock =
  | { type: "entry"; id: string; entryId: EntryId }
  | { type: "activity"; id: string; turnId: string; itemIds: EntryId[] };

/** 纯视图选择器：只把连续 Thought/Tool 组合成 ActivityGroup，不创建第三份聊天状态。 */
export function selectEntryBlocks(collection: EntryCollection): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  let activity: Extract<ChatBlock, { type: "activity" }> | null = null;
  for (const id of collection.order) {
    const entry = collection.byId[id];
    if (!entry) continue;
    if (entry.type === "token_usage") continue;
    if (isActivity(entry)) {
      if (!activity || activity.turnId !== entry.turnId) {
        activity = { type: "activity", id: `activity:${entry.turnId}:${id}`, turnId: entry.turnId, itemIds: [] };
        blocks.push(activity);
      }
      activity.itemIds.push(id);
    } else {
      activity = null;
      blocks.push({ type: "entry", id: `entry:${id}`, entryId: id });
    }
  }
  return blocks;
}

function isActivity(entry: ChatEntry): boolean { return entry.type === "thought" || entry.type === "tool_call"; }
