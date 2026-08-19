import { Check, History, ShieldCheck, Sparkles, Wrench } from "lucide-react";
import type {
  BuiltinToolBinding,
  HistoryPolicy,
  McpBinding,
  McpInstallationView,
  SkillInstallation,
} from "@kindergarten/contracts";

export interface AgentPolicyValue {
  systemPrompt: string;
  builtinTools: BuiltinToolBinding[];
  skillInstallationIds: string[];
  mcps: McpBinding[];
  historyPolicy: HistoryPolicy;
  memoryPolicy: { mode: "off" };
}

export function AgentPolicyFields({
  value,
  builtinToolIds,
  skills,
  mcps,
  onChange,
  readOnly = false,
  showHistory = true,
  showMemory = true,
}: {
  value: AgentPolicyValue;
  builtinToolIds: string[];
  skills: SkillInstallation[];
  mcps: McpInstallationView[];
  onChange: (value: AgentPolicyValue) => void;
  readOnly?: boolean;
  showHistory?: boolean;
  showMemory?: boolean;
}) {
  const tools = builtinToolIds.map((toolId) => value.builtinTools.find((item) => item.toolId === toolId) ?? {
    toolId,
    enabled: false,
    permission: "allow" as const,
  });
  const readySkills = skills.filter((item) => item.state === "ready");
  const connectedMcps = mcps.filter((item) => item.state === "connected");

  function patch(change: Partial<AgentPolicyValue>) {
    if (!readOnly) onChange({ ...value, ...change });
  }

  function toggleMcp(mcp: McpInstallationView, enabled: boolean) {
    const binding: McpBinding = {
      mcpInstallationId: mcp.mcpInstallationId,
      enabled,
      tools: (mcp.snapshot?.tools ?? []).map((item) => ({ remoteName: item.name, enabled: true, permission: "allow" })),
      resources: (mcp.snapshot?.resources ?? []).map((item) => ({ uri: item.uri, enabled: true, preload: false })),
    };
    patch({
      mcps: enabled
        ? [...value.mcps.filter((item) => item.mcpInstallationId !== mcp.mcpInstallationId), binding]
        : value.mcps.filter((item) => item.mcpInstallationId !== mcp.mcpInstallationId),
    });
  }

  return <>
    <section className="product-policy-section">
      <header><ShieldCheck size={16} /><div><strong>Agent 基础指令</strong><small>这是可编辑部分；Runtime 固定指令由运行时追加</small></div></header>
      <label><span>系统提示</span><textarea readOnly={readOnly} required rows={7} value={value.systemPrompt} onChange={(event) => patch({ systemPrompt: event.target.value })} /></label>
    </section>
    <section className="product-policy-section">
      <header><Wrench size={16} /><div><strong>Built-in Tools</strong><small>启用状态与权限共同决定当前模型可见和可执行的能力</small></div></header>
      <div className="product-option-grid">{tools.map((tool) => <label key={tool.toolId}>
        <input checked={tool.enabled} disabled={readOnly} type="checkbox" onChange={(event) => patch({ builtinTools: tools.map((item) => item.toolId === tool.toolId ? { ...item, enabled: event.target.checked } : item) })} />
        <span><strong>{tool.toolId}</strong><select aria-label={`${tool.toolId} 权限`} disabled={readOnly} value={tool.permission} onChange={(event) => patch({ builtinTools: tools.map((item) => item.toolId === tool.toolId ? { ...item, permission: event.target.value as BuiltinToolBinding["permission"] } : item) })}><option value="allow">允许</option><option value="ask">每次询问</option><option value="deny">拒绝</option></select></span>
      </label>)}</div>
    </section>
    <section className="product-policy-section">
      <header><Sparkles size={16} /><div><strong>Skills</strong><small>这里只绑定 Ready Installation；完整 SKILL.md 仍由模型按需加载</small></div></header>
      {readySkills.length === 0 ? <p className="product-inline-empty">还没有可用 Skill。</p> : <div className="product-option-grid">{readySkills.map((skill) => <label key={skill.skillInstallationId}>
        <input checked={value.skillInstallationIds.includes(skill.skillInstallationId)} disabled={readOnly} type="checkbox" onChange={(event) => patch({ skillInstallationIds: event.target.checked ? [...value.skillInstallationIds, skill.skillInstallationId] : value.skillInstallationIds.filter((id) => id !== skill.skillInstallationId) })} />
        <span><strong>{skill.displayName ?? skill.skillName ?? "Skill"}</strong><small>{skillSourceLabel(skill)}</small></span>
      </label>)}</div>}
    </section>
    <section className="product-policy-section">
      <header><Check size={16} /><div><strong>MCP 能力</strong><small>只绑定已连接 Installation；实际 Tool Schema 和 Resource 在只读预览中展示</small></div></header>
      {connectedMcps.length === 0 ? <p className="product-inline-empty">还没有已连接 MCP。</p> : <div className="product-option-grid">{connectedMcps.map((mcp) => <label key={mcp.mcpInstallationId}>
        <input checked={value.mcps.some((item) => item.mcpInstallationId === mcp.mcpInstallationId && item.enabled)} disabled={readOnly} type="checkbox" onChange={(event) => toggleMcp(mcp, event.target.checked)} />
        <span><strong>{mcp.name}</strong><small>{mcp.snapshot?.tools.length ?? 0} Tools · {mcp.snapshot?.resources.length ?? 0} Resources</small></span>
      </label>)}</div>}
    </section>
    {(showHistory || showMemory) && <section className="product-policy-section">
      <header><History size={16} /><div><strong>历史与记忆</strong><small>聊天历史按 Agent 策略生效；Memory 当前固定关闭</small></div></header>
      {showHistory && <><label><span>聊天历史</span><select disabled={readOnly} value={value.historyPolicy.mode} onChange={(event) => patch({ historyPolicy: event.target.value === "none" ? { mode: "none" } : { mode: "recent_turns", maxTurns: 6 } })}><option value="none">不带历史</option><option value="recent_turns">最近若干轮</option></select></label>{value.historyPolicy.mode === "recent_turns" && <label><span>最大轮数</span><input disabled={readOnly} min={1} max={50} type="number" value={value.historyPolicy.maxTurns} onChange={(event) => patch({ historyPolicy: { mode: "recent_turns", maxTurns: Number(event.target.value) } })} /></label>}</>}
      {showMemory && <p className="product-readonly-fact">Memory 固定关闭</p>}
    </section>}
  </>;
}

function skillSourceLabel(skill: SkillInstallation): string {
  if (skill.source.kind === "github_tree") return skill.source.repository;
  return skill.source.kind === "resource_bundle" ? skill.source.url : "本地批准来源";
}
