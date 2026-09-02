import { Check, History, ShieldCheck, Sparkles, Wrench } from "lucide-react";
import type {
  BuiltinToolBinding,
  BuiltinSkillOption,
  HistoryPolicy,
  McpBinding,
  McpInstallationView,
  SkillInstallation,
} from "@kindergarten/contracts";

/** 描述「AgentPolicyValue」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface AgentPolicyValue {
  systemPrompt: string;
  builtinTools: BuiltinToolBinding[];
  builtinSkillIds: string[];
  skillInstallationIds: string[];
  mcps: McpBinding[];
  historyPolicy: HistoryPolicy;
  memoryPolicy: { mode: "off" };
}

/** 渲染「AgentPolicyFields」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function AgentPolicyFields({
  value,
  runtimeBaseInstruction,
  builtinToolIds,
  builtinSkills,
  skills,
  mcps,
  onChange,
  readOnly = false,
  showHistory = true,
  showMemory = true,
}: {
  value: AgentPolicyValue;
  runtimeBaseInstruction: string;
  builtinToolIds: string[];
  builtinSkills: BuiltinSkillOption[];
  skills: SkillInstallation[];
  mcps: McpInstallationView[];
  onChange: (value: AgentPolicyValue) => void;
  readOnly?: boolean;
  showHistory?: boolean;
  showMemory?: boolean;
}) {
  const tools = builtinToolIds.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(toolId) => value.builtinTools.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.toolId === toolId) ?? {
    toolId,
    enabled: false,
    permission: "allow" as const,
  });
  const readySkills = skills.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.state === "ready");
  const connectedMcps = mcps.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.state === "connected");

  /** 执行「patch」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function patch(change: Partial<AgentPolicyValue>) {
    if (!readOnly) onChange({ ...value, ...change });
  }

  /** 根据已校验输入构建「toggleMcp」结果，不额外持有调用方的大对象。 */
function toggleMcp(mcp: McpInstallationView, enabled: boolean) {
    const binding: McpBinding = {
      mcpInstallationId: mcp.mcpInstallationId,
      enabled,
      tools: (mcp.snapshot?.tools ?? []).map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => ({ remoteName: item.name, enabled: true, permission: "allow" })),
      resources: (mcp.snapshot?.resources ?? []).map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => ({ uri: item.uri, enabled: true, preload: false })),
    };
    patch({
      mcps: enabled
        ? [...value.mcps.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.mcpInstallationId !== mcp.mcpInstallationId), binding]
        : value.mcps.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.mcpInstallationId !== mcp.mcpInstallationId),
    });
  }

  return <>
    <section className="product-policy-section">
      <header><ShieldCheck size={16} /><div><strong>Agent 指令</strong><small>自定义指令可编辑；底层规则由 Runtime 固定追加</small></div></header>
      <label><span>Agent 自定义指令（可编辑）</span><textarea readOnly={readOnly} required rows={4} value={value.systemPrompt} onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(event) => patch({ systemPrompt: event.target.value })} /></label>
      <label><span>Runtime 固定指令（只读）</span><textarea aria-label="Runtime 固定指令" className="product-runtime-instructions" readOnly rows={5} value={runtimeBaseInstruction} /></label>
    </section>
    <section className="product-policy-section">
      <header><Wrench size={16} /><div><strong>Built-in Tools</strong><small>启用状态与权限共同决定当前模型可见和可执行的能力</small></div></header>
      <div className="product-option-grid">{tools.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(tool) => <label key={tool.toolId}>
        <input checked={tool.enabled} disabled={readOnly} type="checkbox" onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(event) => patch({ builtinTools: tools.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.toolId === tool.toolId ? { ...item, enabled: event.target.checked } : item) })} />
        <span><strong>{tool.toolId}</strong><select aria-label={`${tool.toolId} 权限`} disabled={readOnly} value={tool.permission} onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(event) => patch({ builtinTools: tools.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.toolId === tool.toolId ? { ...item, permission: event.target.value as BuiltinToolBinding["permission"] } : item) })}><option value="allow">允许</option><option value="ask">每次询问</option><option value="deny">拒绝</option></select></span>
      </label>)}</div>
    </section>
    <section className="product-policy-section">
      <header><Sparkles size={16} /><div><strong>Skills</strong><small>这里只绑定 Ready Installation；完整 SKILL.md 仍由模型按需加载</small></div></header>
      {builtinSkills.length === 0 && readySkills.length === 0 ? <p className="product-inline-empty">还没有可用 Skill。</p> : <div className="product-option-grid">
      {builtinSkills.map((skill) => <label key={skill.skillId}>
        <input checked={value.builtinSkillIds.includes(skill.skillId)} disabled={readOnly} type="checkbox" onChange={(event) => patch({
          builtinSkillIds: event.target.checked
            ? [...value.builtinSkillIds, skill.skillId]
            : value.builtinSkillIds.filter((id) => id !== skill.skillId),
        })} />
        <span><strong>{skill.name}</strong><small>系统内置 · {skill.description}</small></span>
      </label>)}
      {readySkills.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(skill) => <label key={skill.skillInstallationId}>
        <input checked={value.skillInstallationIds.includes(skill.skillInstallationId)} disabled={readOnly} type="checkbox" onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(event) => patch({ skillInstallationIds: event.target.checked ? [...value.skillInstallationIds, skill.skillInstallationId] : value.skillInstallationIds.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(id) => id !== skill.skillInstallationId) })} />
        <span><strong>{skill.displayName ?? skill.skillName ?? "Skill"}</strong><small>用户安装 · {skillSourceLabel(skill)}</small></span>
      </label>)}</div>}
    </section>
    <section className="product-policy-section">
      <header><Check size={16} /><div><strong>MCP 能力</strong><small>只绑定已连接 Installation；实际 Tool Schema 和 Resource 在只读预览中展示</small></div></header>
      {connectedMcps.length === 0 ? <p className="product-inline-empty">还没有已连接 MCP。</p> : <div className="product-option-grid">{connectedMcps.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(mcp) => <label key={mcp.mcpInstallationId}>
        <input checked={value.mcps.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.mcpInstallationId === mcp.mcpInstallationId && item.enabled)} disabled={readOnly} type="checkbox" onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(event) => toggleMcp(mcp, event.target.checked)} />
        <span><strong>{mcp.name}</strong><small>{mcp.snapshot?.tools.length ?? 0} Tools · {mcp.snapshot?.resources.length ?? 0} Resources</small></span>
      </label>)}</div>}
    </section>
    {(showHistory || showMemory) && <section className="product-policy-section">
      <header><History size={16} /><div><strong>历史与记忆</strong><small>聊天历史按 Agent 策略生效；Memory 当前固定关闭</small></div></header>
      {showHistory && <><label><span>聊天历史</span><select disabled={readOnly} value={value.historyPolicy.mode} onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(event) => patch({ historyPolicy: event.target.value === "none" ? { mode: "none" } : { mode: "recent_turns", maxTurns: 6 } })}><option value="none">不带历史</option><option value="recent_turns">最近若干轮</option></select></label>{value.historyPolicy.mode === "recent_turns" && <label><span>最大轮数</span><input disabled={readOnly} min={1} max={50} type="number" value={value.historyPolicy.maxTurns} onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(event) => patch({ historyPolicy: { mode: "recent_turns", maxTurns: Number(event.target.value) } })} /></label>}</>}
      {showMemory && <p className="product-readonly-fact">Memory 固定关闭</p>}
    </section>}
  </>;
}

/** 执行「skillSourceLabel」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function skillSourceLabel(skill: SkillInstallation): string {
  if (skill.source.kind === "github_tree") return skill.source.repository;
  return skill.source.kind === "resource_bundle" ? skill.source.url : "本地批准来源";
}
