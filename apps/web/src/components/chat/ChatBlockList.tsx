import { Fragment } from "react";
import type { EntryCollection } from "../../chat/chat-types.js";
import { selectEntryBlocks } from "../../chat/chat-blocks.js";
import { ActivityGroup } from "../activity/ActivityGroup.js";
import { ContextSummaryEntryView } from "../context/ContextSummaryEntryView.js";
import { MessageEntryView } from "./MessageEntryView.js";
import { RenderErrorBoundary } from "../errors/RenderErrorBoundary.js";

export function ChatBlockList({ collection }: {
  collection: EntryCollection;
}) {
  const blocks = selectEntryBlocks(collection);
  return blocks.map((block) => {
    const content = (() => {
      if (block.type === "activity") {
        return <RenderErrorBoundary scope="entry"><ActivityGroup collection={collection} itemIds={block.itemIds} /></RenderErrorBoundary>;
      }
      const entry = collection.byId[block.entryId];
      if (entry?.type === "message") {
        return <RenderErrorBoundary scope="entry"><MessageEntryView entry={entry} /></RenderErrorBoundary>;
      }
      if (entry?.type === "context_summary") {
        return <RenderErrorBoundary scope="entry"><ContextSummaryEntryView entry={entry} /></RenderErrorBoundary>;
      }
      return null;
    })();
    return <Fragment key={block.id}>{content}</Fragment>;
  });
}
