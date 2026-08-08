import type { ChatEntry, EntryCollection, EntryId } from "./chat-types.js";

export type ChatBlock =
  | { type: "entry"; id: string; entryId: EntryId }
  | { type: "activity"; id: string; turnId: string; itemIds: EntryId[] };

export interface TurnEvaluationAnchor {
  turnId: string;
  afterBlockId: string;
}

/** 纯视图选择器：只把连续 Thought/Tool 组合成 ActivityGroup，不创建第三份聊天状态。 */
export function selectEntryBlocks(collection: EntryCollection): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  let activity: Extract<ChatBlock, { type: "activity" }> | null = null;
  for (const id of collection.order) {
    const entry = collection.byId[id];
    if (!entry) continue;
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

/**
 * 每个真实 Prompt Turn 只在最后一个渲染块后提供一个评测入口。
 * load:* 是 Web 加载历史时的临时操作 ID，不是 Remote 保存的真实 Turn ID。
 */
export function selectTurnEvaluationAnchors(
  collection: EntryCollection,
  blocks = selectEntryBlocks(collection),
): TurnEvaluationAnchor[] {
  const byTurn = new Map<string, TurnEvaluationAnchor>();
  for (const block of blocks) {
    const entryIds = block.type === "entry" ? [block.entryId] : block.itemIds;
    for (const entryId of entryIds) {
      const turnId = collection.byId[entryId]?.turnId;
      if (!turnId || turnId.startsWith("load:")) continue;
      byTurn.set(turnId, { turnId, afterBlockId: block.id });
    }
  }
  return [...byTurn.values()];
}

function isActivity(entry: ChatEntry): boolean { return entry.type === "thought" || entry.type === "tool_call"; }
