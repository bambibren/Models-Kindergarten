import type { MarkColor } from "./types.js";
import "./plan-marker-list.css";

export interface PlanMarkerStep {
  id: string;
  title: string;
  detail?: string;
}

/** Demo 与正式实验页共用同一套双色步骤标注交互。 */
export function PlanMarkerList({ steps, marks, onMark }: {
  steps: PlanMarkerStep[];
  marks: Record<string, MarkColor>;
  onMark: (stepId: string, color: MarkColor) => void;
}) {
  return <div className="plan-flow">
    {steps.map((step, index) => <div className={`plan-step ${marks[step.id] ? `marked-${marks[step.id]}` : ""}`} key={step.id}>
      <span className="plan-number">{String(index + 1).padStart(2, "0")}</span>
      <div><strong>{step.title}</strong>{step.detail && <p>{step.detail}</p>}</div>
      <div className="plan-marker-actions">
        <button aria-label="蓝色标记" className="blue" onClick={() => onMark(step.id, "blue")} type="button" />
        <button aria-label="红色标记" className="red" onClick={() => onMark(step.id, "red")} type="button" />
      </div>
    </div>)}
  </div>;
}
