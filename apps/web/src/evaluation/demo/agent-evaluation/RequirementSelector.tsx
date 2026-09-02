import { Check } from "lucide-react";
import "./requirement-selector.css";

export interface RequirementSelectorItem {
  id: string;
  label: string;
  sources: string[];
  disabled?: boolean;
  disabledTitle?: string;
}

/** Demo 与正式实验页共用同一份真实需求选择和“其他需求”权重交互。 */
export function RequirementSelector({ requirements, selectedIds, hasOtherRequirement, listedRequirementsWeight, onToggle, onOtherRequirementToggle, onWeightChange, weightMin = 0, weightMax = 100 }: {
  requirements: RequirementSelectorItem[];
  selectedIds: string[];
  hasOtherRequirement: boolean;
  listedRequirementsWeight: number;
  onToggle: (requirementId: string) => void;
  onOtherRequirementToggle: () => void;
  onWeightChange: (value: number) => void;
  weightMin?: number;
  weightMax?: number;
}) {
  return <div className="requirement-pool">
    <header><div><span>待标注 LIST</span><strong>请选出您真正的需求</strong></div><small>{selectedIds.length}{hasOtherRequirement ? " + 其他" : ""} 已选</small></header>
    <div className="requirement-pool-list">
      {requirements.map((requirement) => {
        const selected = selectedIds.includes(requirement.id);
        return <button className={selected ? "selected" : ""} disabled={requirement.disabled} key={requirement.id} onClick={() => onToggle(requirement.id)} title={requirement.disabled ? requirement.disabledTitle : requirement.label} type="button">
          <span className="pool-check">{selected && <Check size={12} />}</span>
          <span className="pool-content"><strong className="pool-title">{requirement.label}</strong><small className="pool-source">来源：{requirement.sources.join(" · ")}</small></span>
        </button>;
      })}
    </div>
    <div className={`other-requirement ${hasOtherRequirement ? "selected" : ""}`}>
      <button className="other-requirement-toggle" onClick={onOtherRequirementToggle} type="button">
        <span className="pool-check">{hasOtherRequirement && <Check size={11} />}</span>
        <span className="pool-content"><strong className="pool-title">其他需求</strong><small className="pool-source">当前合并列表未覆盖的真实需求</small></span>
      </button>
      {hasOtherRequirement && <div className="other-requirement-controls"><label>
        <span><strong>已列需求合计权重 {listedRequirementsWeight}%</strong><small>其他需求占 {100 - listedRequirementsWeight}%</small></span>
        <input aria-label="已列需求权重" max={weightMax} min={weightMin} onChange={(event) => onWeightChange(Number(event.target.value))} type="range" value={listedRequirementsWeight} />
        <span className="weight-scale"><i>{weightMin}%</i><i>{weightMax}%</i></span>
      </label></div>}
    </div>
  </div>;
}
