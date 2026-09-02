import { BadgeCheck, BarChart3, BrainCircuit, CircleCheck, CircleX, Gauge, Highlighter, LoaderCircle, MessageSquareText, Pencil, Route } from "lucide-react";
import { useEffect, useState } from "react";
import type { AnnotationTabId, ScoreTabId } from "./types.js";
import "./annotation-tabs.css";

const tabs = [
  { id: "answer", label: "原始回答", icon: MessageSquareText },
  { id: "execution", label: "执行能力", icon: Gauge },
  { id: "understanding", label: "理解能力", icon: BrainCircuit },
  { id: "planning", label: "规划能力", icon: Route },
  { id: "output", label: "输出结果", icon: Highlighter },
  { id: "summary", label: "综合能力分布", icon: BarChart3 },
] as const;

/** 渲染「AnnotationTabs」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function AnnotationTabs({
  active,
  answerLabel = "原始回答",
  answerStatus = "completed",
  executionStatus = answerStatus,
  annotationStatus = "ready",
  completed,
  onChange,
}: {
  active: AnnotationTabId;
  answerLabel?: string;
  answerStatus?: "loading" | "completed";
  executionStatus?: "loading" | "completed" | "failed";
  annotationStatus?: "blocked" | "loading" | "ready";
  completed: Partial<Record<ScoreTabId, boolean>>;
  onChange: (tab: AnnotationTabId) => void;
}) {
  const [generationElapsed, setGenerationElapsed] = useState(0);
  useEffect(() => {
    if (annotationStatus !== "loading") return;
    const startedAt = Date.now();
    setGenerationElapsed(0);
    const timer = window.setInterval(() => setGenerationElapsed(Math.floor((Date.now() - startedAt) / 1_000)), 1_000);
    return () => window.clearInterval(timer);
  }, [annotationStatus]);
  return <nav className="annotation-tabs" aria-label="效果评测模块" role="tablist">
    {tabs.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
    (tab) => {
      const Icon = tab.icon;
      const manual = tab.id === "understanding" || tab.id === "planning" || tab.id === "output";
      const done = manual ? completed[tab.id] === true : tab.id === "execution";
      const followsAnswerStream = tab.id === "answer" || tab.id === "execution";
      const disabled = manual
        ? answerStatus !== "completed" || annotationStatus !== "ready"
        : !followsAnswerStream && answerStatus !== "completed";
      const autoStatus = tab.id === "answer" ? answerStatus : tab.id === "execution" ? executionStatus : undefined;
      const generating = manual && annotationStatus === "loading";
      return <button
        aria-busy={autoStatus === "loading" || generating}
        aria-selected={active === tab.id}
        className={active === tab.id ? "active" : ""}
        disabled={disabled}
        key={tab.id}
        onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => { if (!disabled) onChange(tab.id); }}
        role="tab"
        title={disabled ? generating ? "生成中" : answerStatus !== "completed" ? `${answerLabel}完成后可查看` : "标注题目尚未生成" : undefined}
        type="button"
      >
        <Icon size={14} />
        <span>{tab.id === "answer" ? answerLabel : tab.label}</span>
        {tab.id === "answer" && <i className={`tab-status answer-${answerStatus}`} title={answerStatus === "completed" ? `${answerLabel}已完成` : `${answerLabel}生成中`}>
          {answerStatus === "completed" ? <CircleCheck size={13} /> : <LoaderCircle className="tab-loading-icon" size={13} />}
        </i>}
        {manual && <i
          aria-label={generating ? "题目生成中" : undefined}
          className={`tab-status ${done ? "completed" : generating ? "generating-elapsed" : "manual"}`}
          title={done ? "手动评测完成" : generating ? "生成中" : "需要手动评测"}
        >
          {done ? <BadgeCheck size={13} /> : generating ? <span>生成中.. {generationElapsed}s</span> : <Pencil size={12} />}
        </i>}
        {tab.id === "execution" && <i className={`tab-status execution-${executionStatus}`} title={executionStatus === "completed" ? "执行能力已自动完成" : executionStatus === "failed" ? "执行过程包含失败" : "执行能力生成中"}>
          {executionStatus === "completed" ? <CircleCheck size={13} /> : executionStatus === "failed" ? <CircleX size={13} /> : <LoaderCircle className="tab-loading-icon" size={13} />}
        </i>}
      </button>;
    })}
  </nav>;
}
