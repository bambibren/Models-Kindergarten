import { ArrowLeft, Bot, Save } from "lucide-react";
import { useCallback, useState, type FormEvent } from "react";
import type { AgentInput, McpInstallationView, SkillInstallation } from "@kindergarten/contracts";
import { controlApi } from "../api/control-api.js";
import { AgentPolicyFields, type AgentPolicyValue } from "./AgentPolicyFields.js";
import { ErrorState, LoadingState } from "./LoadState.js";
import { ProductNav } from "./ProductNav.js";
import { useResource } from "./use-resource.js";

/** 渲染「AgentEditorPage」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function AgentEditorPage({ agentId }: { agentId?: string }) {
  const load = useCallback(/** 缓存「load」的派生计算，依赖变化时重新生成以避免陈旧闭包。 */
async () => {
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

/** 渲染「AgentForm」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function AgentForm({ options, skills, mcps, agent }: {
  options: Awaited<ReturnType<typeof controlApi.capabilityOptions>>;
  skills: SkillInstallation[];
  mcps: McpInstallationView[];
  agent: Awaited<ReturnType<typeof controlApi.agent>> | undefined;
}) {
  const [form, setForm] = useState<AgentInput>(/** 执行「[form, setForm]」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => agent ? {
    name: agent.name, ...(agent.description ? { description: agent.description } : {}), systemPrompt: agent.systemPrompt,
    builtinTools: options.builtinTools.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(toolId) => agent.builtinTools.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.toolId === toolId) ?? { toolId, enabled: false, permission: "allow" }),
    builtinSkillIds: agent.builtinSkills.filter((item) => item.enabled).map((item) => item.skillId),
    skillInstallationIds: agent.skills.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.enabled).map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.skillInstallationId),
    mcps: agent.mcps, historyPolicy: agent.historyPolicy, memoryPolicy: { mode: "off" },
  } : {
    name: "", description: "", systemPrompt: "请先理解任务，再使用必要工具；不要声称执行未实际执行的操作。",
    builtinTools: options.builtinTools.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(toolId) => ({
      toolId,
      enabled: ["read_file", "list_files", "ask_user", "read_artifact", "publish_artifact", "publish_artifact_version", "rollback_artifact"].includes(toolId),
      permission: "allow",
    })),
    builtinSkillIds: [], skillInstallationIds: [], mcps: [], historyPolicy: { mode: "recent_turns", maxTurns: 6 }, memoryPolicy: { mode: "off" },
  });
  const [status, setStatus] = useState<"idle" | "submitting" | "succeeded" | "failed">("idle");
  const [message, setMessage] = useState("");
  /** 执行「submit」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async function submit(event: FormEvent) {
    event.preventDefault(); setStatus("submitting"); setMessage("");
    try { const saved = await controlApi.saveAgent(form, agent?.agentId); setStatus("succeeded"); setMessage("Agent 已保存；只影响之后新发起的 Turn。"); if (!agent) history.replaceState(null, "", `/agents/${saved.agentId}`); }
    catch (error) { setStatus("failed"); setMessage(error instanceof Error ? error.message : String(error)); }
  }
  /** 更新「updatePolicy」对应状态，并保持写入顺序、原子性与容量约束。 */
function updatePolicy(policy: AgentPolicyValue) { setForm(/** 更新「updatePolicy」对应状态，并保持写入顺序、原子性与容量约束。 */
(current) => ({ ...current, ...policy })); }
  return <div className="product-editor-shell"><header className="product-page-heading"><a href="/me?tab=agents"><ArrowLeft size={16} /></a><div><span>ACCOUNT · AGENT CONTEXT</span><h1>{agent ? "编辑 Agent" : "创建 Agent"}</h1><p>保存一套可复用的系统提示、工具、Skills、MCP 与历史策略。</p></div></header>
    <form className="product-form" onSubmit={submit}>
      <section><header><Bot size={16} /><div><strong>基础信息</strong><small>名称只是展示；运行时使用保存的 ID</small></div></header><label><span>名称</span><input required maxLength={80} value={form.name} onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(event) => setForm({ ...form, name: event.target.value })} /></label><label><span>说明</span><input maxLength={500} value={form.description ?? ""} onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(event) => setForm({ ...form, description: event.target.value })} /></label></section>
      <AgentPolicyFields builtinSkills={options.builtinSkills} builtinToolIds={options.builtinTools} mcps={mcps} onChange={updatePolicy} skills={skills} value={form} />
      <footer><span className={status}>{message || "最后一次成功保存生效，不需要 ETag 或迁移 Session。"}</span><button disabled={status === "submitting"} type="submit"><Save size={14} />{status === "submitting" ? "正在保存" : "保存 Agent"}</button></footer>
    </form></div>;
}
