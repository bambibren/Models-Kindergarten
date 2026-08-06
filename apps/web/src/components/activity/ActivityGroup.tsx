import type { EntryCollection } from "../../chat/chat-types.js";
import { ReasoningItem } from "./ReasoningItem.js";
import { ToolItem } from "../tools/ToolItem.js";

export function ActivityGroup({ itemIds, collection }: { itemIds: string[]; collection: EntryCollection }) {
  return <section className="activity-group" aria-label="Agent 活动">
    {itemIds.map((id) => {
      const entry = collection.byId[id];
      if (entry?.type === "thought") return <ReasoningItem entry={entry} key={id} />;
      if (entry?.type === "tool_call") return <ToolItem entry={entry} key={id} />;
      return null;
    })}
  </section>;
}
