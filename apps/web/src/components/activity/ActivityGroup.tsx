import type { EntryCollection } from "../../chat/chat-types.js";
import { ReasoningItem } from "./ReasoningItem.js";
import { ToolItem } from "../tools/ToolItem.js";

/** 渲染「ActivityGroup」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function ActivityGroup({ itemIds, collection }: { itemIds: string[]; collection: EntryCollection }) {
  return <section className="activity-group" aria-label="Agent 活动">
    {itemIds.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(id) => {
      const entry = collection.byId[id];
      if (entry?.type === "thought") return <ReasoningItem entry={entry} key={id} />;
      if (entry?.type === "tool_call") return <ToolItem entry={entry} key={id} />;
      return null;
    })}
  </section>;
}
