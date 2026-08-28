import { useMemo, useState } from "react";
import {
  Bot,
  Braces,
  Check,
  Download,
  FlaskConical,
  LockKeyhole,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import type { ContextExperimentMode, ContextModuleId, DemoContextVersion } from "../demo-types.js";
import { demoAgentStrategies } from "../demo-data.js";
import { loadSavedAgents, mergeAgentStrategies } from "../agent-editor/agent-storage.js";
import { DemoTopNav } from "../shared/DemoTopNav.js";
import { AgentStrategyFields } from "./AgentStrategyFields.js";
import {
  addVersion,
  canRunExperiment,
  createFreshVersions,
  createHistoryVersions,
  removeVersion,
  replaceVersionModules,
  updateModule,
  versionTokenLabel,
} from "./context-lab-state.js";
import "./context-lab.css";

const historyPrompt = "请读取课程需求，为模型幼儿园制作一个静态介绍页，并说明你生成了哪些产物。";
/** 渲染「ContextLabPage」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function ContextLabPage() {
  const query = useMemo(/** 缓存「query」的派生计算，依赖变化时重新生成以避免陈旧闭包。 */
() => new URLSearchParams(location.search), []);
  const mode: ContextExperimentMode = query.get("mode") === "turn" ? "history_turn" : "fresh_prompt";
  const turnId = query.get("turnId") ?? "turn-demo-731";
  const [prompt, setPrompt] = useState(mode === "history_turn" ? historyPrompt : "");
  const [versions, setVersions] = useState<DemoContextVersion[]>(/** 执行「[versions, setVersions]」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => mode === "history_turn" ? createHistoryVersions() : createFreshVersions());
  const [activeId, setActiveId] = useState<DemoContextVersion["id"]>("a");
  const [importOpen, setImportOpen] = useState(false);
  const [importedAgentNames, setImportedAgentNames] = useState<Partial<Record<DemoContextVersion["id"], string>>>({});
  const [availableAgents] = useState(/** 执行「[availableAgents]」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => mergeAgentStrategies(loadSavedAgents(sessionStorage), demoAgentStrategies));
  const active = versions.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(version) => version.id === activeId) ?? versions[0];
  const runnable = canRunExperiment(mode, prompt, versions);

  /** 执行「reset」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function reset() {
    setVersions(mode === "history_turn" ? createHistoryVersions() : createFreshVersions());
    setActiveId("a");
    setImportedAgentNames({});
  }

  /** 执行「addComparison」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function addComparison() {
    const next = addVersion(versions);
    setVersions(next);
    if (next.length > versions.length) setActiveId("c");
  }

  /** 释放或删除「removeComparison」对应资源，重复调用仍保持安全。 */
function removeComparison(id: DemoContextVersion["id"]) {
    const next = removeVersion(versions, id);
    setVersions(next);
    if (!next.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(version) => version.id === activeId)) setActiveId(next[0]?.id ?? "a");
    setImportedAgentNames(/** 释放或删除「removeComparison」对应资源，重复调用仍保持安全。 */
(current) => {
      const nextNames = { ...current };
      delete nextNames[id];
      return nextNames;
    });
  }

  /** 执行「patchModule」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function patchModule(moduleId: ContextModuleId, updater: Parameters<typeof updateModule>[3]) {
    setVersions(/** 执行「patchModule」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(current) => updateModule(current, activeId, moduleId, updater));
  }

  /** 执行「importAgent」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function importAgent(agentId: string) {
    const agent = availableAgents.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(candidate) => candidate.id === agentId);
    if (!agent) return;
    setVersions(/** 执行「importAgent」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(current) => replaceVersionModules(current, activeId, agent.modules));
    setImportedAgentNames(/** 执行「importAgent」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(current) => ({ ...current, [activeId]: agent.name }));
    setImportOpen(false);
  }

  /** 执行「runExperiment」主流程，传播取消与失败并在结束时清理临时资源。 */
function runExperiment() {
    if (!runnable) return;
    const target = new URL("http://127.0.0.1:5175/evaluation/demo/agent-comparison");
    target.searchParams.set("source", mode === "history_turn" ? "history-turn" : "fresh-prompt");
    if (mode === "history_turn") target.searchParams.set("turnId", turnId);
    location.href = target.toString();
  }

  return <main className="mk-demo-app mk-context-lab">
    <DemoTopNav active="context" />
    <header className="mk-context-lab-heading">
      <div>
        <span className="mk-demo-kicker">MODEL CONTEXT · EXPERIMENT</span>
        <h1>模型上下文实验</h1>
        <p>{mode === "history_turn" ? "保留历史原始输入与结果，只重新运行你新增的对照版本。" : "用同一个问题比较 2–3 种上下文策略，观察模型行为如何改变。"}</p>
      </div>
      <button type="button" onClick={reset}><RotateCcw size={14} />重置策略</button>
    </header>

    <section className="mk-context-prompt" aria-labelledby="context-prompt-title">
      <header><div><strong id="context-prompt-title">实验问题</strong><small>{mode === "history_turn" ? `来自 ${turnId}` : "新问题 · 可编辑"}</small></div>{mode === "history_turn" && <span><LockKeyhole size={12} />不可编辑</span>}</header>
      {mode === "history_turn"
        ? <div className="mk-context-prompt-bubble">{prompt}</div>
        : <textarea aria-label="实验问题" value={prompt} onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(event) => setPrompt(event.target.value)} placeholder="输入一个要让不同上下文策略共同回答的问题…" rows={3} />}
    </section>

    <section className="mk-context-runbar">
      <div>
        <strong>{runnable ? "已满足对比条件" : "先让至少两个版本存在一项策略差异"}</strong>
        <small>{mode === "history_turn" ? "A 复用历史快照；其余版本重新调用模型" : `${versions.length} 个版本将分别重新调用模型`}</small>
      </div>
      <button disabled={!runnable} type="button" onClick={runExperiment}><FlaskConical size={15} />开始对比实验</button>
    </section>

    <div className="mk-context-workbench">
      <aside className="mk-context-version-rail">
        <header><strong>上下文版本</strong><small>最少 2 个，最多 3 个</small></header>
        <div className="mk-context-version-list">
          {versions.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(version) => <div className={`mk-context-version-tab ${activeId === version.id ? "active" : ""}`} key={version.id}>
            <button type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => setActiveId(version.id)}>
              <span>{version.id.toUpperCase()}</span>
              <div><strong>{version.name}</strong><small>{version.runPolicy === "reuse_snapshot" ? "复用历史结果" : versionTokenLabel(version)}</small></div>
              {activeId === version.id && <Check size={13} />}
            </button>
            {!version.locked && versions.length > 2 && <button aria-label={`删除${version.name}`} className="mk-context-version-remove" type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => removeComparison(version.id)}><Trash2 size={12} /></button>}
          </div>)}
        </div>
        <button className="mk-context-add" disabled={versions.length >= 3} type="button" onClick={addComparison}><Plus size={14} />添加对照版本</button>
        <p>同一模型、同一问题，只有上下文策略不同。</p>
      </aside>

      {active && <section className="mk-context-editor">
        <header>
          <div><span>{active.id.toUpperCase()}</span><div><strong>{active.name}</strong><small>{active.locked ? "历史快照 · 只读" : "上下文策略 · 可编辑"}</small></div></div>
          <div className="mk-context-editor-actions">
            {!active.locked && <button type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => setImportOpen(true)}><Download size={13} />导入已有 Agent 策略</button>}
            <span className={active.locked ? "locked" : "editable"}>{active.locked ? <LockKeyhole size={12} /> : <Braces size={12} />}{active.locked ? "不会重新运行" : versionTokenLabel(active)}</span>
          </div>
        </header>
        {importedAgentNames[active.id] && !active.locked && <div className="mk-context-imported-note"><Bot size={13} />已载入“{importedAgentNames[active.id]}”，你可以继续修改当前版本。</div>}
        <AgentStrategyFields configuration={active} onPatch={patchModule} prompt={prompt} />
      </section>}
    </div>
    {importOpen && <div className="mk-context-import-overlay" role="presentation" onMouseDown={/** 处理「onMouseDown」事件，校验归属后再推进状态且避免重复提交。 */
(event) => { if (event.target === event.currentTarget) setImportOpen(false); }}>
      <section aria-labelledby="agent-import-title" aria-modal="true" className="mk-context-import-dialog" role="dialog">
        <header><div><strong id="agent-import-title">导入已有 Agent 策略</strong><small>只覆盖当前可编辑版本的策略表单。</small></div><button aria-label="关闭导入 Agent" type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => setImportOpen(false)}><X size={16} /></button></header>
        <div>{availableAgents.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(agent) => <button key={agent.id} type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => importAgent(agent.id)}><Bot size={15} /><span><strong>{agent.name}</strong><small>{agent.description}</small></span><em>{agent.state === "active" ? "可用" : "草稿"}</em></button>)}</div>
      </section>
    </div>}
  </main>;
}
