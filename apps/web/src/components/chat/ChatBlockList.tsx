import type { EntryCollection } from "../../chat/chat-types.js";
import { selectEntryBlocks } from "../../chat/chat-blocks.js";
import { ActivityGroup } from "../activity/ActivityGroup.js";
import { MessageEntryView } from "./MessageEntryView.js";
import { RenderErrorBoundary } from "../errors/RenderErrorBoundary.js";

export function ChatBlockList({ collection }: { collection: EntryCollection }) {
  return selectEntryBlocks(collection).map((block) => {
    if (block.type === "activity") return <RenderErrorBoundary scope="entry" key={block.id}><ActivityGroup collection={collection} itemIds={block.itemIds} /></RenderErrorBoundary>;
    const entry = collection.byId[block.entryId];
    return entry?.type === "message" ? <RenderErrorBoundary scope="entry" key={block.id}><MessageEntryView entry={entry} /></RenderErrorBoundary> : null;
  });
}
