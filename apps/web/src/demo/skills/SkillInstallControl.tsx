import { Check, Download, LoaderCircle } from "lucide-react";
import { useState } from "react";
import {
  demoSkillPhaseLabel,
  isDemoSkillInstallComplete,
  skillInstallProgress,
  type DemoSkillRecord,
} from "./skill-install-state.js";
import { useDemoSkillInstall } from "./use-demo-skill-install.js";
import "./skill-install.css";

export function SkillInstallControl({ variant, onInstalled }: {
  variant: "panel" | "inline";
  onInstalled: (records: DemoSkillRecord[]) => void;
}) {
  const [sourceUrl, setSourceUrl] = useState("");
  const { batch, error, start } = useDemoSkillInstall((records) => {
    onInstalled(records);
    setSourceUrl("");
  });
  const installing = Boolean(batch && !isDemoSkillInstallComplete(batch));
  const progress = batch ? skillInstallProgress(batch) : null;

  function install() {
    if (!sourceUrl.trim() || installing) return;
    start([sourceUrl.trim()]);
  }

  return <section className={`mk-skill-install-control ${variant}`}>
    <div className="mk-skill-install-copy">
      <strong>{variant === "panel" ? "从网络添加 Skill" : "安装并加入可选 Skills"}</strong>
      <small>粘贴公开 GitHub 仓库或目录地址；真实安装按层查找，只安装第一次出现 SKILL.md 的深度。</small>
    </div>
    <div className="mk-skill-install-fields">
      <input aria-label="Skill 安装地址" disabled={installing} onChange={(event) => setSourceUrl(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); install(); } }} placeholder="GitHub 中直接包含 SKILL.md 的目录地址" value={sourceUrl} />
      <button disabled={!sourceUrl.trim() || installing} type="button" onClick={install}>{installing ? <LoaderCircle className="mk-demo-spin" size={13} /> : <Download size={13} />}安装</button>
    </div>
    {error && <p className="mk-skill-install-error" role="alert">{error}</p>}
    {batch && progress && <div className={`mk-skill-install-result ${isDemoSkillInstallComplete(batch) ? "ready" : "running"}`} role="status">
      {isDemoSkillInstallComplete(batch) ? <Check size={13} /> : <LoaderCircle className="mk-demo-spin" size={13} />}
      <span><strong>{batch.items[0]?.name}</strong><small>{demoSkillPhaseLabel(progress.phase)}</small></span>
    </div>}
  </section>;
}
