import { useEffect, useRef } from "react";
import { Beaker, ChevronLeft, FlaskConical } from "lucide-react";
import type { DemoSavedComparison } from "./types.js";
import { scrollTopForVisibleItem } from "./comparison-state.js";

export function ComparisonHistoryRail({ records, selectedId }: {
  records: DemoSavedComparison[];
  selectedId: string | null;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLAnchorElement>());

  useEffect(() => {
    if (!selectedId) return;
    const viewport = viewportRef.current;
    const item = itemRefs.current.get(selectedId);
    if (!viewport || !item) return;
    viewport.scrollTop = scrollTopForVisibleItem(
      viewport.scrollTop,
      viewport.clientHeight,
      item.offsetTop,
      item.offsetHeight,
    );
  }, [selectedId]);

  return <aside className="comparison-history-rail">
    <header><a aria-label="返回模型幼儿园" href="http://127.0.0.1:5174/demo/context-lab?mode=new"><ChevronLeft size={15} /></a><div><span>SAVED</span><strong>对照实验</strong></div></header>
    <div className="comparison-current"><FlaskConical size={14} /><div><strong>本次实验</strong><small>{selectedId ? "已保存结果" : "未保存 · 临时结果"}</small></div></div>
    <div className="comparison-history-label"><span>历史记录</span><small>{records.length}</small></div>
    <div className="comparison-history-list" ref={viewportRef}>
      {records.map((record) => <a
        className={selectedId === record.id ? "active" : ""}
        href={`/evaluation/demo/agent-comparison?comparisonId=${encodeURIComponent(record.id)}`}
        key={record.id}
        ref={(node) => {
          if (node) itemRefs.current.set(record.id, node);
          else itemRefs.current.delete(record.id);
        }}
      >
        <span>{record.variantCount}</span><div><strong>{record.title}</strong><small>{record.createdAt}</small></div>
      </a>)}
    </div>
    <footer><a href="http://127.0.0.1:5174/demo/me?tab=experiments"><Beaker size={13} />打开我的对照实验</a></footer>
  </aside>;
}
