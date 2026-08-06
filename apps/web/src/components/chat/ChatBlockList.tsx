import type { EntryCollection } from "../../chat/chat-types.js";
import { selectEntryBlocks } from "../../chat/chat-blocks.js";
import { ActivityGroup } from "../activity/ActivityGroup.js";
import { MessageEntryView } from "./MessageEntryView.js";

export function ChatBlockList({ collection }: { collection: EntryCollection }) {
  return selectEntryBlocks(collection).map((block) => {
    if (block.type === "activity") return <ActivityGroup collection={collection} itemIds={block.itemIds} key={block.id} />;
    const entry = collection.byId[block.entryId];
    return entry?.type === "message" ? <MessageEntryView entry={entry} key={block.id} /> : null;
  });
}
