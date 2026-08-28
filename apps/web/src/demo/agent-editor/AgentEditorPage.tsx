import { useMemo, useState } from "react";
import { ArrowLeft, Bot, Check, Save } from "lucide-react";
import { demoAgentStrategies } from "../demo-data.js";
import type { ContextModuleId, DemoAgentStrategy, DemoContextModule } from "../demo-types.js";
import { DemoTopNav } from "../shared/DemoTopNav.js";
import { AgentStrategyFields, type ModuleUpdater, type StrategyOption } from "../context-lab/AgentStrategyFields.js";
import { cloneModules, createDefaultModules } from "../context-lab/context-lab-state.js";
import { loadSavedAgents, mergeAgentStrategies, saveAgent } from "./agent-storage.js";
import { SkillInstallControl } from "../skills/SkillInstallControl.js";
import { listDemoSkills } from "../skills/skill-install-state.js";
import "../context-lab/context-lab.css";
import "./agent-editor.css";

/** 渲染「AgentEditorPage」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function AgentEditorPage() {
  const query = useMemo(/** 缓存「query」的派生计算，依赖变化时重新生成以避免陈旧闭包。 */
() => new URLSearchParams(location.search), []);
  const agentId = query.get("agentId");
  const [availableAgents] = useState(/** 执行「[availableAgents]」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => mergeAgentStrategies(loadSavedAgents(sessionStorage), demoAgentStrategies));
  const source = availableAgents.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(agent) => agent.id === agentId);
  const editMode = Boolean(source);
  const [name, setName] = useState(source?.name ?? "");
  const [description, setDescription] = useState(source?.description ?? "");
  const [saved, setSaved] = useState(false);
  const [modules, setModules] = useState<DemoContextModule[]>(/** 执行「[modules, setModules]」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => source ? cloneModules(source.modules) : createDefaultModules());
  const [skills, setSkills] = useState(/** 执行「[skills, setSkills]」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => listDemoSkills(sessionStorage));
  const skillOptions: StrategyOption[] = skills.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(skill) => ({
    name: skill.name,
    meta: `${skill.status === "ready" ? "已安装" : "草稿"} · ${skill.sourceUrl.startsWith("local:") ? "Local" : "GitHub"}`,
    available: skill.status === "ready",
  }));

  /** 执行「patchModule」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function patchModule(moduleId: ContextModuleId, updater: ModuleUpdater) {
    setSaved(false);
    setModules(/** 执行「patchModule」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(current) => current.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(module) => module.id === moduleId ? updater(module) : module));
  }

  /** 执行「submit」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function submit(event: React.FormEvent) {
    event.preventDefault();
    const normalizedName = name.trim();
    if (!normalizedName) return;
    const record: DemoAgentStrategy = {
      id: source?.id ?? `agent-custom-${Date.now()}`,
      name: normalizedName,
      description: description.trim() || "自定义上下文策略",
      modules: cloneModules(modules),
      updatedAt: "刚刚",
      state: "active",
    };
    saveAgent(sessionStorage, record);
    setSaved(true);
  }

  return <main className="mk-demo-app mk-agent-editor-page">
    <DemoTopNav active="context" />
    <div className="mk-agent-editor-shell">
      <header className="mk-agent-editor-heading">
        <a aria-label="返回我的 Agents" href="/demo/me?tab=agents"><ArrowLeft size={16} /></a>
        <div><span className="mk-demo-kicker">AGENT · CONTEXT STRATEGY</span><h1>{editMode ? `编辑 ${source?.name}` : "创建 Agent"}</h1><p>Agent 是 ModelStudent 的可复用上下文策略；模型、问题和具体聊天内容在运行时再注入。</p></div>
      </header>

      <form className="mk-agent-editor-form" onSubmit={submit}>
        <section className="mk-agent-identity-panel">
          <div><Bot size={17} /></div>
          <label><span>Agent 名称</span><input aria-label="Agent 名称" autoFocus={!editMode} maxLength={32} onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(event) => { setName(event.target.value); setSaved(false); }} placeholder="例如：长文写作 Agent" required value={name} /></label>
          <label><span>用途说明</span><input aria-label="Agent 用途说明" maxLength={80} onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(event) => { setDescription(event.target.value); setSaved(false); }} placeholder="一句话说明这个 Agent 适合什么任务" value={description} /></label>
        </section>

        <section className="mk-context-editor mk-agent-strategy-editor">
          <header><div><span><Bot size={14} /></span><div><strong>{name.trim() || "未命名 Agent"}</strong><small>上下文策略 · 可编辑</small></div></div><span className="editable">同一 Agent · 保存即更新</span></header>
          <AgentStrategyFields
            configuration={{ locked: false, modules }}
            onPatch={patchModule}
            prompt="[运行时用户输入]"
            rawTitle="Agent 策略原文预览"
            skillInstallSlot={<SkillInstallControl onInstalled={/** 处理「onInstalled」事件，校验归属后再推进状态且避免重复提交。 */
() => setSkills(listDemoSkills(sessionStorage))} variant="inline" />}
            skillOptions={skillOptions}
          />
        </section>

        <footer className="mk-agent-editor-actions">
          <span>{saved ? <><Check size={13} />已更新“我的 Agents”</> : "保存会直接更新这个 Agent，不创建版本或快照。Demo 数据保存在当前浏览器会话中。"}</span>
          {saved && <a href="/demo/me?tab=agents">查看我的 Agents</a>}
          <button disabled={!name.trim() || saved} type="submit"><Save size={14} />{saved ? "已保存" : "保存 Agent"}</button>
        </footer>
      </form>
    </div>
  </main>;
}
