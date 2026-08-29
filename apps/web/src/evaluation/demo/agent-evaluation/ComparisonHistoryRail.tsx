import { useEffect, useRef } from "react";
import { ChevronLeft, FlaskConical } from "lucide-react";
import type { DemoSavedComparison } from "./types.js";
import { scrollTopForVisibleItem } from "./comparison-state.js";

/** 渲染「ComparisonHistoryRail」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function ComparisonHistoryRail({ records, selectedId }: {
  records: DemoSavedComparison[];
  selectedId: string | null;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLAnchorElement>());

  useEffect(/** 同步组件生命周期内的外部状态，并在清理阶段释放订阅或临时资源。 */
() => {
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
    <header><a aria-label="返回模型幼儿园" href="/demo/model-home"><ChevronLeft size={15} /></a><div><span>SAVED</span><strong>对照实验</strong></div></header>
    <div className="comparison-current"><FlaskConical size={14} /><div><strong>本次实验</strong><small>{selectedId ? "已保存结果" : "未保存 · 临时结果"}</small></div></div>
    <div className="comparison-history-label"><span>历史记录</span><small>{records.length}</small></div>
    <div className="comparison-history-list" ref={viewportRef}>
      {records.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(record) => <a
        className={selectedId === record.id ? "active" : ""}
        href={`/evaluation/demo/agent-comparison?comparisonId=${encodeURIComponent(record.id)}`}
        key={record.id}
        ref={/** 执行「ref」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(node) => {
          if (node) itemRefs.current.set(record.id, node);
          else itemRefs.current.delete(record.id);
        }}
      >
        <span>{record.variantCount}</span><div><strong>{record.title}</strong><small>{record.createdAt}</small></div>
      </a>)}
    </div>
    {/* 上下文实验功能调研期间不暴露“我的对照实验”入口。 */}
  </aside>;
}
