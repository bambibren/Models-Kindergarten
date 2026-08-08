import { Fragment } from "react";
import type { EntryCollection } from "../../chat/chat-types.js";
import {
  selectEntryBlocks,
  selectTurnEvaluationAnchors,
} from "../../chat/chat-blocks.js";
import { ActivityGroup } from "../activity/ActivityGroup.js";
import { MessageEntryView } from "./MessageEntryView.js";
import { RenderErrorBoundary } from "../errors/RenderErrorBoundary.js";
import { TurnEvaluationLink } from "../evaluation/TurnEvaluationLink.js";

export function ChatBlockList({ collection, sessionId, showEvaluationLinks = false }: {
  collection: EntryCollection;
  sessionId: string | null;
  showEvaluationLinks?: boolean;
}) {
  const blocks = selectEntryBlocks(collection);
  const anchors = showEvaluationLinks && sessionId
    ? new Map(selectTurnEvaluationAnchors(collection, blocks).map((item) => [item.afterBlockId, item]))
    : new Map();
  return blocks.map((block) => {
    const content = (() => {
      if (block.type === "activity") {
        return <RenderErrorBoundary scope="entry"><ActivityGroup collection={collection} itemIds={block.itemIds} /></RenderErrorBoundary>;
      }
      const entry = collection.byId[block.entryId];
      return entry?.type === "message"
        ? <RenderErrorBoundary scope="entry"><MessageEntryView entry={entry} /></RenderErrorBoundary>
        : null;
    })();
    const anchor = anchors.get(block.id);
    return <Fragment key={block.id}>
      {content}
      {anchor && sessionId && <TurnEvaluationLink sessionId={sessionId} turnId={anchor.turnId} />}
    </Fragment>;
  });
}
