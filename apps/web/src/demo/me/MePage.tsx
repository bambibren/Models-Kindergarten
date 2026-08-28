import { useState } from "react";
import {
  Blocks,
  Bot,
  Braces,
  ExternalLink,
  KeyRound,
  Link2,
  Plus,
  Sparkles,
  UserRound,
} from "lucide-react";
import { demoAgentStrategies, demoMcpInstallations, demoModelStudents } from "../demo-data.js";
import type { DemoAgentStrategy, DemoMcpInstallation, DemoModelStudent } from "../demo-types.js";
import { loadSavedAgents, mergeAgentStrategies } from "../agent-editor/agent-storage.js";
import { loadRemovedMcpIds, loadSavedMcps, mcpStateLabel, mergeMcpInstallations } from "../mcp/mcp-demo-state.js";
import { SkillInstallControl } from "../skills/SkillInstallControl.js";
import { listDemoSkills, type DemoSkillRecord } from "../skills/skill-install-state.js";
import { DemoTopNav } from "../shared/DemoTopNav.js";
import "./me.css";

type MeTab = "agents" | "models" | "mcps" | "skills";

const tabs: Array<{ id: MeTab; label: string; icon: typeof Braces }> = [
  // 上下文实验功能调研期间不展示“我的对照实验”板块。
  { id: "agents", label: "我的 Agents", icon: Braces },
  { id: "models", label: "我的 Models", icon: Bot },
  { id: "mcps", label: "我的 MCPs", icon: Blocks },
  { id: "skills", label: "我的 Skills", icon: Sparkles },
];

/** 渲染「MePage」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function MePage() {
  const requestedTab = new URLSearchParams(location.search).get("tab") as MeTab | null;
  const [activeTab, setActiveTab] = useState<MeTab>(tabs.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(tab) => tab.id === requestedTab) ? requestedTab! : "agents");
  const [agents] = useState(/** 执行「[agents]」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => mergeAgentStrategies(loadSavedAgents(sessionStorage), demoAgentStrategies));
  const models = demoModelStudents;
  const [mcps] = useState(/** 执行「[mcps]」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => mergeMcpInstallations(loadSavedMcps(sessionStorage), demoMcpInstallations, loadRemovedMcpIds(sessionStorage)));
  const [skills, setSkills] = useState(/** 执行「[skills, setSkills]」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => listDemoSkills(sessionStorage));

  /** 执行「selectTab」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function selectTab(tab: MeTab) {
    setActiveTab(tab);
    const next = new URL(location.href);
    next.searchParams.set("tab", tab);
    history.replaceState(null, "", next);
  }

  return <main className="mk-demo-app mk-me-page">
    <DemoTopNav active="me" />
    <div className="mk-me-shell">
      <aside className="mk-me-profile">
        <div className="mk-me-avatar"><UserRound size={23} /></div>
        <strong>Admin</strong>
        <span>本地 Demo 账号</span>
        <dl><div><dt>Models</dt><dd>{models.length}</dd></div><div><dt>Agents</dt><dd>{agents.length}</dd></div><div><dt>MCPs</dt><dd>{mcps.length}</dd></div><div><dt>Skills</dt><dd>{skills.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(skill) => skill.status === "ready").length}</dd></div></dl>
        <p>账号与权限系统尚未接入；本页使用 Admin 的固定示例数据。</p>
      </aside>

      <section className="mk-me-content">
        <header>
          <span className="mk-demo-kicker">ADMIN · PERSONAL SPACE</span>
          <h1>我的</h1>
        </header>
        <nav className="mk-me-tabs" aria-label="我的资源">
          {tabs.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(tab) => {
            const Icon = tab.icon;
            return <button className={activeTab === tab.id ? "active" : ""} key={tab.id} type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => selectTab(tab.id)}><Icon size={14} />{tab.label}</button>;
          })}
        </nav>

        {/* 上下文实验功能调研期间不展示实验记录面板。 */}
        {activeTab === "agents" ? <AgentPanel agents={agents} /> : activeTab === "mcps" ? <McpPanel installations={mcps} /> : activeTab === "skills" ? <SkillPanel onRefresh={/** 处理「onRefresh」事件，校验归属后再推进状态且避免重复提交。 */
() => setSkills(listDemoSkills(sessionStorage))} skills={skills} /> : <ModelPanel models={models} />}
      </section>
    </div>
  </main>;
}

/** 渲染「McpPanel」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function McpPanel({ installations }: { installations: DemoMcpInstallation[] }) {
  return <section className="mk-me-panel mk-me-mcp-panel">
    <header className="mk-me-panel-heading">
      <div><strong>我的 MCPs</strong><small>Admin 账号已安装的远程 Streamable HTTP 服务；Agent 只能选择这里处于“已连接”的 MCP。</small></div>
      <a className="mk-me-agent-add" href="/demo/mcp?mode=create"><Plus size={13} />添加远程 MCP</a>
    </header>
    <div className="mk-me-mcp-list">
      {installations.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(mcp) => <a href={`/demo/mcp?mcpId=${encodeURIComponent(mcp.id)}`} key={mcp.id}>
        <span className={`mk-me-mcp-state is-${mcp.state}`} aria-label={mcpStateLabel(mcp.state)} />
        <div className="mk-me-mcp-copy"><strong>{mcp.name}</strong><p>{mcp.description}</p><small><Link2 size={12} />{mcp.url}</small></div>
        <div className="mk-me-mcp-meta"><span>{mcp.capabilities.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.kind === "tool").length} Tools</span><span>{mcp.authKind === "bearer" ? <><KeyRound size={11} />Bearer</> : "无需鉴权"}</span></div>
        <em>{mcpStateLabel(mcp.state)}</em><ExternalLink size={13} />
      </a>)}
    </div>
    <p className="mk-me-mcp-footnote">“安装”表示将远程服务配置保存到 Admin；“连接”表示当前凭据已通过验证。这里不提供 stdio 或服务端软件安装。</p>
  </section>;
}

/** 渲染「SkillPanel」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function SkillPanel({ skills, onRefresh }: { skills: DemoSkillRecord[]; onRefresh: () => void }) {
  return <section className="mk-me-panel mk-me-skills-panel">
    <header className="mk-me-panel-heading"><div><strong>我的 Skills</strong><small>安装到个人 Skill 库；不会自动修改任何 Agent。</small></div></header>
    <SkillInstallControl onInstalled={onRefresh} variant="panel" />
    <div className="mk-me-resource-list">
      {skills.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(skill) => <article key={skill.id}><div><strong>{skill.name}</strong><p>{skill.description}</p></div><span title={skill.sourceUrl}>{skill.sourceUrl.startsWith("local:") ? "Local · SKILL.md" : "GitHub · 用户安装"}</span><em>{skill.status === "ready" ? "已安装" : "草稿"}</em></article>)}
    </div>
  </section>;
}

/** 渲染「AgentPanel」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function AgentPanel({ agents }: { agents: DemoAgentStrategy[] }) {
  return <section className="mk-me-panel">
    <header className="mk-me-panel-heading"><div><strong>可复用的 Agent</strong><small>点击具体 Agent 编辑，并在新会话中继续使用。</small></div><a className="mk-me-agent-add" href="/demo/agent-editor?mode=create"><Plus size={13} />创建 Agent</a></header>
    <div className="mk-me-agent-list">
      {agents.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(agent) => <a href={`/demo/agent-editor?agentId=${encodeURIComponent(agent.id)}`} key={agent.id}>
        <span><Braces size={15} /></span><div><strong>{agent.name}</strong><p>{agent.description}</p><small>{agent.modules.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(module) => module.enabled).length} 个启用模块 · {agent.updatedAt}</small></div><em>{agent.state === "active" ? "可用" : "草稿"}</em><ExternalLink size={13} />
      </a>)}
    </div>
  </section>;
}

/** 渲染「ModelPanel」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function ModelPanel({ models }: { models: DemoModelStudent[] }) {
  return <section className="mk-me-panel">
    <header className="mk-me-panel-heading"><div><strong>我的 Models</strong><small>当前只展示内置 ModelStudent；模型入园功能不在本轮范围内。</small></div></header>
    <div className="mk-me-resource-list">
      {models.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(model) => <article key={model.id}><div><strong>{model.name}</strong><p>{model.model} · {model.provider}</p></div><span>{protocolLabel(model)} · {model.score === null ? "待评测" : `${model.score} 分`}</span><em>{model.state}</em></article>)}
    </div>
  </section>;
}

/** 执行「protocolLabel」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function protocolLabel(model: DemoModelStudent): string {
  if (model.protocol === "ollama_native") return "Ollama";
  if (model.protocol === "openai_chat_completions") return "Chat Completions";
  return "Responses";
}
