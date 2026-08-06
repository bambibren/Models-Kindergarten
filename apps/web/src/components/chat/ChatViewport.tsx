import { useEffect, useMemo, useRef } from "react";
import { GraduationCap } from "lucide-react";
import type { EntryCollection } from "../../chat/chat-types.js";
import { ChatBlockList } from "./ChatBlockList.js";
import { PromptTurnLoader } from "./PromptTurnLoader.js";

export function ChatViewport({ entries, streamingEntries, running }: { entries: EntryCollection; streamingEntries: EntryCollection; running: boolean }) {
  const viewportRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followsBottom = useRef(true);
  const count = entries.order.length + streamingEntries.order.length;
  const lastId = useMemo(() => streamingEntries.order.at(-1) ?? entries.order.at(-1), [entries.order, streamingEntries.order]);
  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const follow = () => {
      if (followsBottom.current) viewport.scrollTop = viewport.scrollHeight;
    };
    follow();
    const observer = new ResizeObserver(follow);
    observer.observe(content);
    return () => observer.disconnect();
  }, [lastId, count]);

  function updateFollowState() {
    const viewport = viewportRef.current;
    if (!viewport) return;
    followsBottom.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 72;
  }
  if (count === 0) return <section className="empty-state">
    <span className="empty-mark"><GraduationCap size={23} /></span>
    <h1>今天想让模型学习什么？</h1>
    <p>本地 qwen3:8b 通过 ACP 与沙箱工具协作。你可以让它读取文件、写入文件，或在需要时向你提问。</p>
    <div className="suggestion-grid"><span>总结 sandbox 中的文件</span><span>新建一份学习笔记</span><span>读取 README 并解释架构</span></div>
  </section>;
  return <section className="chat-viewport" ref={viewportRef} onScroll={updateFollowState} aria-live="polite"><div className="chat-content" ref={contentRef}>
    <ChatBlockList collection={entries} />
    <ChatBlockList collection={streamingEntries} />
    {running && <PromptTurnLoader />}
  </div></section>;
}
