import { BadgeCheck, BarChart3, BrainCircuit, CircleCheck, Gauge, Highlighter, Pencil, Route } from "lucide-react";
import type { AnnotationTabId, ScoreTabId } from "./types.js";

const tabs = [
  { id: "understanding", label: "理解能力", icon: BrainCircuit },
  { id: "planning", label: "规划能力", icon: Route },
  { id: "output", label: "输出结果", icon: Highlighter },
  { id: "execution", label: "执行能力", icon: Gauge },
  { id: "summary", label: "综合能力分布", icon: BarChart3 },
] as const;

export function AnnotationTabs({
  active,
  completed,
  onChange,
}: {
  active: AnnotationTabId;
  completed: Partial<Record<ScoreTabId, boolean>>;
  onChange: (tab: AnnotationTabId) => void;
}) {
  return <nav className="annotation-tabs" aria-label="人工标注模块" role="tablist">
    {tabs.map((tab) => {
      const Icon = tab.icon;
      const manual = tab.id === "understanding" || tab.id === "planning" || tab.id === "output";
      const done = manual ? completed[tab.id] === true : tab.id === "execution";
      return <button
        aria-selected={active === tab.id}
        className={active === tab.id ? "active" : ""}
        key={tab.id}
        onClick={() => onChange(tab.id)}
        role="tab"
        type="button"
      >
        <Icon size={14} />
        <span>{tab.label}</span>
        {manual && <i className={`tab-status ${done ? "completed" : "manual"}`} title={done ? "手动标记完成" : "需要手动标记"}>
          {done ? <BadgeCheck size={13} /> : <Pencil size={12} />}
        </i>}
        {tab.id === "execution" && <i className="tab-status automatic" title="自动完成"><CircleCheck size={13} /></i>}
      </button>;
    })}
  </nav>;
}
