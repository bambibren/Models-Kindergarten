import { useEffect, useMemo, useRef } from "react";
import type { EntryCollection } from "../../chat/chat-types.js";
import {
  canDisplaySessionTokenTotal,
  isPromptTurnActive,
  type PromptTurnState,
  type TurnAction,
} from "../../prompt-turn/prompt-turn-types.js";
import { ChatBlockList } from "./ChatBlockList.js";
import { PromptTurnLoader } from "./PromptTurnLoader.js";
import { PromptTurnStatusRow } from "../errors/PromptTurnStatusRow.js";
import { Loader } from "../primitives/Loader.js";
import { TokenUsageTotal } from "./TokenUsageTotal.js";
import { Gauge } from "lucide-react";

/** 渲染「ChatViewport」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function ChatViewport({ historyPaging, historyChatEntries, streamingChatEntries, initializing, promptTurn, sessionId, scorableTurnIds, onTurnAction, onLoadOlder }: {
  historyPaging: { loading: boolean; hasMore: boolean };
  historyChatEntries: EntryCollection;
  streamingChatEntries: EntryCollection;
  initializing: boolean;
  promptTurn: PromptTurnState;
  sessionId?: string | null;
  scorableTurnIds?: ReadonlySet<string>;
  onTurnAction: (action: TurnAction) => void;
  onLoadOlder: () => void;
}) {
  const viewportRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followsBottom = useRef(true);
  const count = historyChatEntries.order.length + streamingChatEntries.order.length;
  const lastId = useMemo(
    /** 缓存「lastId」的派生计算，依赖变化时重新生成以避免陈旧闭包。 */
() => streamingChatEntries.order.at(-1) ?? historyChatEntries.order.at(-1),
    [historyChatEntries.order, streamingChatEntries.order],
  );
  useEffect(/** 同步组件生命周期内的外部状态，并在清理阶段释放订阅或临时资源。 */
() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const follow = /** 执行「follow」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => {
      if (followsBottom.current) viewport.scrollTop = viewport.scrollHeight;
    };
    follow();
    const observer = new ResizeObserver(follow);
    observer.observe(content);
    return /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */ () => observer.disconnect();
  }, [lastId, count]);

  /** 更新「updateFollowState」对应状态，并保持写入顺序、原子性与容量约束。 */
function updateFollowState() {
    const viewport = viewportRef.current;
    if (!viewport) return;
    followsBottom.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 72;
  }
  if (count === 0) return <section className="session-empty-state">
    {initializing ? <Loader size="lg" label="正在初始化会话" /> : null}
  </section>;
  return <section className="chat-viewport" ref={viewportRef} onScroll={updateFollowState} aria-live="polite"><div className="chat-content" ref={contentRef}>
    {historyPaging.hasMore ? <div className="history-page-control"><button
      disabled={historyPaging.loading}
      type="button"
      onClick={onLoadOlder}
    >{historyPaging.loading ? "正在加载更早记录…" : "加载更早的 20 个 Turn"}</button></div> : null}
    <ChatBlockList collection={historyChatEntries} renderTurnFooter={(turnId) => sessionId && scorableTurnIds?.has(turnId) ? <div className="turn-score-action">
      <a href={`/evaluation/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}`}><Gauge size={14} />效果打分</a>
    </div> : null} />
    <ChatBlockList collection={streamingChatEntries} />
    {isPromptTurnActive(promptTurn) && <PromptTurnLoader turn={promptTurn} />}
    {!isPromptTurnActive(promptTurn) && <PromptTurnStatusRow state={promptTurn} onAction={onTurnAction} />}
    {canDisplaySessionTokenTotal(promptTurn) && <TokenUsageTotal
      history={historyChatEntries}
      streaming={streamingChatEntries}
    />}
  </div></section>;
}
