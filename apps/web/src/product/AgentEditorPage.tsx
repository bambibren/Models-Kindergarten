import { ArrowLeft, Bot, Save } from "lucide-react";
import { useCallback, useState, type FormEvent } from "react";
import type { AgentInput, McpInstallationView, SkillInstallation } from "@kindergarten/contracts";
import { controlApi } from "../api/control-api.js";
import { AgentPolicyFields, type AgentPolicyValue } from "./AgentPolicyFields.js";
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
    builtinTools: options.builtinTools.map((toolId) => agent.builtinTools.find((item) => item.toolId === toolId) ?? { toolId, enabled: false, permission: "allow" }), skillInstallationIds: agent.skills.filter((item) => item.enabled).map((item) => item.skillInstallationId),
    mcps: agent.mcps, historyPolicy: agent.historyPolicy, memoryPolicy: { mode: "off" },
  } : {
    name: "", description: "", systemPrompt: "请先理解任务，再使用必要工具；不要声称执行未实际执行的操作。",
    builtinTools: options.builtinTools.map((toolId) => ({
      toolId,
      enabled: ["read_file", "list_files", "ask_user", "read_artifact", "publish_artifact", "publish_artifact_version", "rollback_artifact"].includes(toolId),
      permission: "allow",
    })),
    skillInstallationIds: [], mcps: [], historyPolicy: { mode: "recent_turns", maxTurns: 6 }, memoryPolicy: { mode: "off" },
  });
  const [status, setStatus] = useState<"idle" | "submitting" | "succeeded" | "failed">("idle");
  const [message, setMessage] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); setStatus("submitting"); setMessage("");
    try { const saved = await controlApi.saveAgent(form, agent?.agentId); setStatus("succeeded"); setMessage("Agent 已保存；只影响之后新发起的 Turn。"); if (!agent) history.replaceState(null, "", `/agents/${saved.agentId}`); }
    catch (error) { setStatus("failed"); setMessage(error instanceof Error ? error.message : String(error)); }
  }
  function updatePolicy(policy: AgentPolicyValue) { setForm((current) => ({ ...current, ...policy })); }
  return <div className="product-editor-shell"><header className="product-page-heading"><a href="/me?tab=agents"><ArrowLeft size={16} /></a><div><span>ADMIN · AGENT CONTEXT</span><h1>{agent ? "编辑 Agent" : "创建 Agent"}</h1><p>保存一套可复用的系统提示、工具、Skills、MCP 与历史策略。</p></div></header>
    <form className="product-form" onSubmit={submit}>
      <section><header><Bot size={16} /><div><strong>基础信息</strong><small>名称只是展示；运行时使用保存的 ID</small></div></header><label><span>名称</span><input required maxLength={80} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label><label><span>说明</span><input maxLength={500} value={form.description ?? ""} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label></section>
      <AgentPolicyFields builtinToolIds={options.builtinTools} mcps={mcps} onChange={updatePolicy} skills={skills} value={form} />
      <footer><span className={status}>{message || "最后一次成功保存生效，不需要 ETag 或迁移 Session。"}</span><button disabled={status === "submitting"} type="submit"><Save size={14} />{status === "submitting" ? "正在保存" : "保存 Agent"}</button></footer>
    </form></div>;
}
