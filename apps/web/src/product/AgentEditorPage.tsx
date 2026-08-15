import { ArrowLeft, Bot, Check, Save, Sparkles, Wrench } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { AgentInput, McpBinding, McpInstallationView, SkillInstallation } from "@kindergarten/contracts";
import { controlApi } from "../api/control-api.js";
import { ErrorState, LoadingState } from "./LoadState.js";
import { ProductNav } from "./ProductNav.js";
import { useResource } from "./use-resource.js";

export function AgentEditorPage({ agentId }: { agentId?: string }) {
  const load = useCallback(async () => {
    const [options, skills, mcps, agent] = await Promise.all([
      controlApi.capabilityOptions(), controlApi.skills(), controlApi.mcps(), agentId ? controlApi.agent(agentId) : Promise.resolve(undefined),
    ]);
    return { options, skills: skills.items, mcps, agent };
  }, [agentId]);
  const { state, retry } = useResource(load);
  return <main className="product-page"><ProductNav active="agent" />
    {state.phase === "loading" ? <LoadingState label="正在读取 Agent 能力" /> : state.phase === "error" ? <ErrorState {...state} retry={retry} /> : <AgentForm {...state.data} />}
  </main>;
}

function AgentForm({ options, skills, mcps, agent }: {
  options: Awaited<ReturnType<typeof controlApi.capabilityOptions>>;
  skills: SkillInstallation[];
  mcps: McpInstallationView[];
  agent: Awaited<ReturnType<typeof controlApi.agent>> | undefined;
}) {
  const [form, setForm] = useState<AgentInput>(() => agent ? {
    name: agent.name, ...(agent.description ? { description: agent.description } : {}), systemPrompt: agent.systemPrompt,
    builtinTools: agent.builtinTools, skillInstallationIds: agent.skills.filter((item) => item.enabled).map((item) => item.skillInstallationId),
    mcps: agent.mcps, historyPolicy: agent.historyPolicy, memoryPolicy: { mode: "off" },
  } : {
    name: "", description: "", systemPrompt: "请先理解任务，再使用必要工具；不要声称执行未实际执行的操作。",
    builtinTools: options.builtinTools.map((toolId) => ({ toolId, enabled: ["read_file", "list_files", "ask_user"].includes(toolId), permission: toolId === "write_file" || toolId === "run_command" ? "ask" : "allow" })),
    skillInstallationIds: [], mcps: [], historyPolicy: { mode: "recent_turns", maxTurns: 6 }, memoryPolicy: { mode: "off" },
  });
  const [status, setStatus] = useState<"idle" | "submitting" | "succeeded" | "failed">("idle");
  const [message, setMessage] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); setStatus("submitting"); setMessage("");
    try { const saved = await controlApi.saveAgent(form, agent?.agentId); setStatus("succeeded"); setMessage("Agent 已保存；只影响之后新发起的 Turn。"); if (!agent) history.replaceState(null, "", `/agents/${saved.agentId}`); }
    catch (error) { setStatus("failed"); setMessage(error instanceof Error ? error.message : String(error)); }
  }
  function toggleMcp(mcp: McpInstallationView, enabled: boolean) {
    const binding: McpBinding = {
      mcpInstallationId: mcp.mcpInstallationId, enabled,
      tools: (mcp.snapshot?.tools ?? []).map((item) => ({ remoteName: item.name, enabled: true, permission: "allow" })),
      resources: (mcp.snapshot?.resources ?? []).map((item) => ({ uri: item.uri, enabled: true, preload: false })),
    };
    setForm((current) => ({ ...current, mcps: enabled ? [...current.mcps.filter((item) => item.mcpInstallationId !== mcp.mcpInstallationId), binding] : current.mcps.filter((item) => item.mcpInstallationId !== mcp.mcpInstallationId) }));
  }
  return <div className="product-editor-shell"><header className="product-page-heading"><a href="/me?tab=agents"><ArrowLeft size={16} /></a><div><span>ADMIN · AGENT CONTEXT</span><h1>{agent ? "编辑 Agent" : "创建 Agent"}</h1><p>保存一套可复用的系统提示、工具、Skills、MCP 与历史策略。</p></div></header>
    <form className="product-form" onSubmit={submit}>
      <section><header><Bot size={16} /><div><strong>基础信息</strong><small>名称只是展示；运行时使用保存的 ID</small></div></header><label><span>名称</span><input required maxLength={80} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label><label><span>说明</span><input maxLength={500} value={form.description ?? ""} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label><label><span>系统提示</span><textarea rows={7} required value={form.systemPrompt} onChange={(event) => setForm({ ...form, systemPrompt: event.target.value })} /></label></section>
      <section><header><Wrench size={16} /><div><strong>Built-in Tools</strong><small>写文件和运行命令始终至少需要本次确认</small></div></header><div className="product-option-grid">{form.builtinTools.map((tool) => <label key={tool.toolId}><input type="checkbox" checked={tool.enabled} onChange={(event) => setForm({ ...form, builtinTools: form.builtinTools.map((item) => item.toolId === tool.toolId ? { ...item, enabled: event.target.checked } : item) })} /><span><strong>{tool.toolId}</strong><select value={tool.permission} onChange={(event) => setForm({ ...form, builtinTools: form.builtinTools.map((item) => item.toolId === tool.toolId ? { ...item, permission: event.target.value as "allow" | "ask" | "deny" } : item) })}><option value="allow">允许</option><option value="ask">每次询问</option><option value="deny">拒绝</option></select></span></label>)}</div></section>
      <section><header><Sparkles size={16} /><div><strong>Skills</strong><small>这里只能绑定已就绪 Installation；使用时模型调用 activate_skill</small></div></header>{skills.length === 0 ? <p className="product-inline-empty">还没有安装 Skill，可在“我的 Skills”安装。</p> : <div className="product-option-grid">{skills.filter((item) => item.state === "ready").map((skill) => <label key={skill.skillInstallationId}><input type="checkbox" checked={form.skillInstallationIds.includes(skill.skillInstallationId)} onChange={(event) => setForm({ ...form, skillInstallationIds: event.target.checked ? [...form.skillInstallationIds, skill.skillInstallationId] : form.skillInstallationIds.filter((id) => id !== skill.skillInstallationId) })} /><span><strong>{skill.displayName ?? skill.skillName ?? "Skill"}</strong><small>{skill.source.kind === "github_tree" ? skill.source.repository : "本地批准来源"}</small></span></label>)}</div>}</section>
      <section><header><Check size={16} /><div><strong>MCP 能力</strong><small>Agent 只获得当前发现快照里的 Tools 与 Resources</small></div></header>{mcps.filter((item) => item.state === "connected").length === 0 ? <p className="product-inline-empty">还没有已连接 MCP。</p> : <div className="product-option-grid">{mcps.filter((item) => item.state === "connected").map((mcp) => <label key={mcp.mcpInstallationId}><input type="checkbox" checked={form.mcps.some((item) => item.mcpInstallationId === mcp.mcpInstallationId)} onChange={(event) => toggleMcp(mcp, event.target.checked)} /><span><strong>{mcp.name}</strong><small>{mcp.snapshot?.tools.length ?? 0} Tools · {mcp.snapshot?.resources.length ?? 0} Resources</small></span></label>)}</div>}</section>
      <section><header><Check size={16} /><div><strong>历史策略</strong><small>Memory 首版固定关闭</small></div></header><label><span>聊天历史</span><select value={form.historyPolicy.mode} onChange={(event) => setForm({ ...form, historyPolicy: event.target.value === "none" ? { mode: "none" } : { mode: "recent_turns", maxTurns: 6 } })}><option value="none">不带历史</option><option value="recent_turns">最近若干轮</option></select></label>{form.historyPolicy.mode === "recent_turns" && <label><span>最大轮数</span><input min={1} max={50} type="number" value={form.historyPolicy.maxTurns} onChange={(event) => setForm({ ...form, historyPolicy: { mode: "recent_turns", maxTurns: Number(event.target.value) } })} /></label>}</section>
      <footer><span className={status}>{message || "最后一次成功保存生效，不需要 ETag 或迁移 Session。"}</span><button disabled={status === "submitting"} type="submit"><Save size={14} />{status === "submitting" ? "正在保存" : "保存 Agent"}</button></footer>
    </form></div>;
}
