import { useMemo, useState } from "react";
import {
  Beaker,
  Blocks,
  Bot,
  Braces,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  KeyRound,
  Link2,
  Plus,
  Search,
  Sparkles,
  UserRound,
} from "lucide-react";
import { demoAgentStrategies, demoExperiments, demoMcpInstallations, demoModelStudents } from "../demo-data.js";
import type { DemoAgentStrategy, DemoMcpInstallation, DemoModelStudent } from "../demo-types.js";
import { loadSavedAgents, mergeAgentStrategies } from "../agent-editor/agent-storage.js";
import { loadRemovedMcpIds, loadSavedMcps, mcpStateLabel, mergeMcpInstallations } from "../mcp/mcp-demo-state.js";
import { SkillInstallControl } from "../skills/SkillInstallControl.js";
import { listDemoSkills, type DemoSkillRecord } from "../skills/skill-install-state.js";
import { DemoTopNav } from "../shared/DemoTopNav.js";
import { loadSavedModelStudents, mergeModelStudents } from "../model-admission/model-admission-state.js";
import { filterExperiments, pageCount, pageExperiments } from "./me-data.js";
import "./me.css";

type MeTab = "experiments" | "agents" | "models" | "mcps" | "skills";

const tabs: Array<{ id: MeTab; label: string; icon: typeof Beaker }> = [
  { id: "experiments", label: "我的对照实验", icon: Beaker },
  { id: "agents", label: "我的 Agents", icon: Braces },
  { id: "models", label: "我的 Models", icon: Bot },
  { id: "mcps", label: "我的 MCPs", icon: Blocks },
  { id: "skills", label: "我的 Skills", icon: Sparkles },
];

export function MePage() {
  const query = useMemo(() => new URLSearchParams(location.search), []);
  const requestedTab = query.get("tab") as MeTab | null;
  const [activeTab, setActiveTab] = useState<MeTab>(tabs.some((tab) => tab.id === requestedTab) ? requestedTab! : "experiments");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [agents] = useState(() => mergeAgentStrategies(loadSavedAgents(sessionStorage), demoAgentStrategies));
  const [models] = useState(() => mergeModelStudents(loadSavedModelStudents(sessionStorage), demoModelStudents));
  const [mcps] = useState(() => mergeMcpInstallations(loadSavedMcps(sessionStorage), demoMcpInstallations, loadRemovedMcpIds(sessionStorage)));
  const [skills, setSkills] = useState(() => listDemoSkills(sessionStorage));
  const filtered = filterExperiments(demoExperiments, search);
  const totalPages = pageCount(filtered.length);
  const visibleExperiments = pageExperiments(filtered, Math.min(page, totalPages));

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
        <dl><div><dt>Models</dt><dd>{models.length}</dd></div><div><dt>Agents</dt><dd>{agents.length}</dd></div><div><dt>MCPs</dt><dd>{mcps.length}</dd></div><div><dt>Skills</dt><dd>{skills.filter((skill) => skill.status === "ready").length}</dd></div></dl>
        <p>账号与权限系统尚未接入；本页使用 Admin 的固定示例数据。</p>
      </aside>

      <section className="mk-me-content">
        <header>
          <span className="mk-demo-kicker">ADMIN · PERSONAL SPACE</span>
          <h1>我的</h1>
        </header>
        <nav className="mk-me-tabs" aria-label="我的资源">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return <button className={activeTab === tab.id ? "active" : ""} key={tab.id} type="button" onClick={() => selectTab(tab.id)}><Icon size={14} />{tab.label}</button>;
          })}
        </nav>

        {activeTab === "experiments" ? <section className="mk-me-panel">
          <header className="mk-me-panel-heading">
            <div><strong>已保存的对照实验</strong><small>只有点击过“保存本次对照实验结果”的记录才会出现在这里。</small></div>
            <label><Search size={13} /><input aria-label="搜索对照实验" placeholder="搜索标题、问题或模型" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} /></label>
          </header>
          <div className="mk-me-experiment-list">
            {visibleExperiments.map((record) => <a href={`http://127.0.0.1:5175/evaluation/demo/agent-comparison?comparisonId=${encodeURIComponent(record.id)}`} key={record.id}>
              <span className="mk-me-record-mark">{record.versionCount}</span>
              <div><strong>{record.title}</strong><p>{record.prompt}</p><small>{record.model} · {record.createdAt}</small></div>
              <ExternalLink size={14} />
            </a>)}
            {visibleExperiments.length === 0 && <div className="mk-me-empty">没有匹配的对照实验。</div>}
          </div>
          <footer className="mk-me-pagination"><span>共 {filtered.length} 条 · 每页 10 条</span><div><button aria-label="上一页" disabled={page <= 1} type="button" onClick={() => setPage((value) => Math.max(1, value - 1))}><ChevronLeft size={14} /></button><span>{Math.min(page, totalPages)} / {totalPages}</span><button aria-label="下一页" disabled={page >= totalPages} type="button" onClick={() => setPage((value) => Math.min(totalPages, value + 1))}><ChevronRight size={14} /></button></div></footer>
        </section> : activeTab === "agents" ? <AgentPanel agents={agents} /> : activeTab === "mcps" ? <McpPanel installations={mcps} /> : activeTab === "skills" ? <SkillPanel onRefresh={() => setSkills(listDemoSkills(sessionStorage))} skills={skills} /> : <ModelPanel models={models} />}
      </section>
    </div>
  </main>;
}

function McpPanel({ installations }: { installations: DemoMcpInstallation[] }) {
  return <section className="mk-me-panel mk-me-mcp-panel">
    <header className="mk-me-panel-heading">
      <div><strong>我的 MCPs</strong><small>Admin 账号已安装的远程 Streamable HTTP 服务；Agent 只能选择这里处于“已连接”的 MCP。</small></div>
      <a className="mk-me-agent-add" href="/demo/mcp?mode=create"><Plus size={13} />添加远程 MCP</a>
    </header>
    <div className="mk-me-mcp-list">
      {installations.map((mcp) => <a href={`/demo/mcp?mcpId=${encodeURIComponent(mcp.id)}`} key={mcp.id}>
        <span className={`mk-me-mcp-state is-${mcp.state}`} aria-label={mcpStateLabel(mcp.state)} />
        <div className="mk-me-mcp-copy"><strong>{mcp.name}</strong><p>{mcp.description}</p><small><Link2 size={12} />{mcp.url}</small></div>
        <div className="mk-me-mcp-meta"><span>{mcp.capabilities.filter((item) => item.kind === "tool").length} Tools</span><span>{mcp.authKind === "bearer" ? <><KeyRound size={11} />Bearer</> : "无需鉴权"}</span></div>
        <em>{mcpStateLabel(mcp.state)}</em><ExternalLink size={13} />
      </a>)}
    </div>
    <p className="mk-me-mcp-footnote">“安装”表示将远程服务配置保存到 Admin；“连接”表示当前凭据已通过验证。这里不提供 stdio 或服务端软件安装。</p>
  </section>;
}

function SkillPanel({ skills, onRefresh }: { skills: DemoSkillRecord[]; onRefresh: () => void }) {
  return <section className="mk-me-panel mk-me-skills-panel">
    <header className="mk-me-panel-heading"><div><strong>我的 Skills</strong><small>安装到个人 Skill 库；不会自动修改任何 Agent。</small></div></header>
    <SkillInstallControl onInstalled={onRefresh} variant="panel" />
    <div className="mk-me-resource-list">
      {skills.map((skill) => <article key={skill.id}><div><strong>{skill.name}</strong><p>{skill.description}</p></div><span title={skill.sourceUrl}>{skill.sourceUrl.startsWith("local:") ? "Local · SKILL.md" : "GitHub · 用户安装"}</span><em>{skill.status === "ready" ? "已安装" : "草稿"}</em></article>)}
    </div>
  </section>;
}

function AgentPanel({ agents }: { agents: DemoAgentStrategy[] }) {
  return <section className="mk-me-panel">
    <header className="mk-me-panel-heading"><div><strong>可复用的上下文策略</strong><small>点击具体 Agent 编辑；也可以在上下文实验中导入。</small></div><a className="mk-me-agent-add" href="/demo/agent-editor?mode=create"><Plus size={13} />创建 Agent</a></header>
    <div className="mk-me-agent-list">
      {agents.map((agent) => <a href={`/demo/agent-editor?agentId=${encodeURIComponent(agent.id)}`} key={agent.id}>
        <span><Braces size={15} /></span><div><strong>{agent.name}</strong><p>{agent.description}</p><small>{agent.modules.filter((module) => module.enabled).length} 个启用模块 · {agent.updatedAt}</small></div><em>{agent.state === "active" ? "可用" : "草稿"}</em><ExternalLink size={13} />
      </a>)}
    </div>
  </section>;
}

function ModelPanel({ models }: { models: DemoModelStudent[] }) {
  return <section className="mk-me-panel">
    <header className="mk-me-panel-heading"><div><strong>我的 Models</strong><small>包含内置示例和通过入园 Demo 保存的 ModelStudent；API Key 原文不会显示或持久化。</small></div><a className="mk-me-agent-add" href="/demo/model-admission"><Plus size={13} />新模型入园</a></header>
    <div className="mk-me-resource-list">
      {models.map((model) => <article key={model.id}><div><strong>{model.name}</strong><p>{model.model} · {model.provider}</p></div><span>{protocolLabel(model)} · {model.score === null ? "待评测" : `${model.score} 分`}</span><em>{model.state}</em></article>)}
    </div>
  </section>;
}

function protocolLabel(model: DemoModelStudent): string {
  if (model.protocol === "ollama_native") return "Ollama";
  if (model.protocol === "openai_chat_completions") return "Chat Completions";
  return "Responses";
}
