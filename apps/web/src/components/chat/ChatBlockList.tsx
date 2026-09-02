import { Fragment, type ReactNode } from "react";
import type { EntryCollection } from "../../chat/chat-types.js";
import { selectEntryBlocks } from "../../chat/chat-blocks.js";
import { ActivityGroup } from "../activity/ActivityGroup.js";
import { ContextSummaryEntryView } from "../context/ContextSummaryEntryView.js";
import { MessageEntryView } from "./MessageEntryView.js";
import { RenderErrorBoundary } from "../errors/RenderErrorBoundary.js";
import type { ArtifactNavigation } from "./ContentRenderer.js";

/** 渲染「ChatBlockList」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function ChatBlockList({ collection, artifactNavigation, renderTurnFooter }: {
  collection: EntryCollection;
  artifactNavigation?: ArtifactNavigation | undefined;
  renderTurnFooter?: ((turnId: string) => ReactNode) | undefined;
}) {
  const blocks = selectEntryBlocks(collection);
  const lastBlockByTurn = new Map<string, number>();
  blocks.forEach((block, index) => lastBlockByTurn.set(blockTurnId(block, collection), index));
  return blocks.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(block, index) => {
    const turnId = blockTurnId(block, collection);
    const content = (/** 执行「content」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => {
      if (block.type === "activity") {
        return <RenderErrorBoundary scope="entry"><ActivityGroup artifactNavigation={artifactNavigation} collection={collection} itemIds={block.itemIds} /></RenderErrorBoundary>;
      }
      const entry = collection.byId[block.entryId];
      if (entry?.type === "message") {
        return <RenderErrorBoundary scope="entry"><MessageEntryView artifactNavigation={artifactNavigation} entry={entry} /></RenderErrorBoundary>;
      }
      if (entry?.type === "context_summary") {
        return <RenderErrorBoundary scope="entry"><ContextSummaryEntryView entry={entry} /></RenderErrorBoundary>;
      }
      return null;
    })();
    return <Fragment key={block.id}>{content}{lastBlockByTurn.get(turnId) === index ? renderTurnFooter?.(turnId) : null}</Fragment>;
  });
}

function blockTurnId(block: ReturnType<typeof selectEntryBlocks>[number], collection: EntryCollection): string {
  if (block.type === "activity") return block.turnId;
  return collection.byId[block.entryId]?.turnId ?? "";
}
