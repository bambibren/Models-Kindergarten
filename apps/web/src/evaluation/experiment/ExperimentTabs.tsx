import { AnnotationTabs } from "../demo/agent-evaluation/AnnotationTabs.js";
import type { AnnotationTabId } from "../demo/agent-evaluation/types.js";

export type ExperimentTabId = "answers" | "understanding" | "planning" | "output" | "execution" | "summary";
export type ExperimentAnnotationTabId = "understanding" | "planning" | "output";

/** 正式页仅转换历史 answers ID，Tab 本体直接复用 Demo。 */
export function ExperimentTabs({ active, answerStatus, executionStatus, annotationStatus, completed, onChange }: {
  active: ExperimentTabId;
  answerStatus: "loading" | "completed";
  executionStatus?: "loading" | "completed" | "failed";
  annotationStatus?: "blocked" | "loading" | "ready";
  completed: Record<ExperimentAnnotationTabId, boolean>;
  onChange: (tab: ExperimentTabId) => void;
}) {
  return <AnnotationTabs
    active={(active === "answers" ? "answer" : active) as AnnotationTabId}
    answerStatus={answerStatus}
    {...(executionStatus ? { executionStatus } : {})}
    {...(annotationStatus ? { annotationStatus } : {})}
    completed={completed}
    onChange={(tab) => onChange(tab === "answer" ? "answers" : tab)}
  />;
}

export function isAnnotationTab(tab: ExperimentTabId): tab is ExperimentAnnotationTabId {
  return tab === "understanding" || tab === "planning" || tab === "output";
}
