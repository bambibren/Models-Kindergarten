import { Check, ChevronDown, Info, LoaderCircle } from "lucide-react";
import {
  demoSkillPhaseLabel,
  isDemoSkillInstallComplete,
  skillInstallProgress,
  type DemoSkillInstallBatch,
} from "../skills/skill-install-state.js";

export function SkillInstallBanner({ batch }: { batch: DemoSkillInstallBatch }) {
  const progress = skillInstallProgress(batch);
  const ready = isDemoSkillInstallComplete(batch);
  return <details className={`mk-skill-install-banner ${ready ? "ready" : "running"}`}>
    <summary>
      <span className="mk-skill-install-banner-icon">{ready ? <Check size={14} /> : <LoaderCircle className="mk-demo-spin" size={14} />}</span>
      <div><strong>{ready ? "Skills 已安装并启用" : "正在为当前 Agent 安装 Skills"}</strong><small>{ready ? "即将继续网站设计任务" : `${demoSkillPhaseLabel(progress.phase)} · ${progress.completed}/${progress.total} 已就绪`}</small></div>
      <Info size={13} />
      <ChevronDown size={13} />
    </summary>
    <div className="mk-skill-install-banner-list">
      {batch.items.map((item) => <div key={item.id}><span>{item.phase === "ready" || item.phase === "reused" ? <Check size={11} /> : <LoaderCircle className="mk-demo-spin" size={11} />}</span><strong>{item.name}</strong><small>{demoSkillPhaseLabel(item.phase)}</small></div>)}
    </div>
  </details>;
}
