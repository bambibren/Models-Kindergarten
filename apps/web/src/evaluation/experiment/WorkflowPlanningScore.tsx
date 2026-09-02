import type { ExperimentAnnotationWorksheet } from "@kindergarten/contracts";

/** 只读 Workflow 与人工评分控件保持同层，但二者之间不存在自动评分关系。 */
export function WorkflowPlanningScore({ steps, score, variantId, onChange }: {
  steps: ExperimentAnnotationWorksheet["workflows"][number]["steps"];
  score?: number | undefined;
  variantId: string;
  onChange: (score: number) => void;
}) {
  return <div className="planning-score-workspace">
    <div className="workflow-readonly">{steps.length === 0
      ? <div className="workflow-empty"><strong>没有可观察规划</strong><p>模型输出中没有明确表达可提取的宏观任务规划；这不代表评分。</p></div>
      : steps.map((step, index) => <div className="workflow-step" key={step.stepId}><span>{String(index + 1).padStart(2, "0")}</span><strong>{step.label}</strong></div>)}</div>
    <label className="planning-score-control" htmlFor={`planning-score-${variantId}`}><span>人工主观评分</span><strong>{score ?? "未评分"}</strong>{score === undefined ? null : <small>/ 100</small>}</label>
    <input aria-label={`Test ${variantId} 规划能力评分滑块`} id={`planning-score-${variantId}`} max="100" min="0" step="1" type="range" value={score ?? 50} onChange={(event) => onChange(Number(event.currentTarget.value))} />
  </div>;
}
