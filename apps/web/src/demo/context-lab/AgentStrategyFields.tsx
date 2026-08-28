import { ChevronDown, ExternalLink, History, KeyRound, Server } from "lucide-react";
import { demoMcpInstallations, demoSkills } from "../demo-data.js";
import type { ReactNode } from "react";
import type { ContextModuleId, DemoContextModule } from "../demo-types.js";
import { loadRemovedMcpIds, loadSavedMcps, mcpStateLabel, mergeMcpInstallations } from "../mcp/mcp-demo-state.js";
import { modelPayload, moduleTokenLabel, updateSelectedItems } from "./context-lab-state.js";

/** 描述「StrategyOption」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface StrategyOption {
  name: string;
  meta: string;
  available: boolean;
}

/** 描述「AgentStrategyConfiguration」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface AgentStrategyConfiguration {
  locked: boolean;
  modules: DemoContextModule[];
}

const toolOptions: StrategyOption[] = ["read_file", "write_file", "list_files", "ask_user"].map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(name) => ({ name, meta: "内置 Tool", available: true }));
const defaultSkillOptions: StrategyOption[] = demoSkills.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => ({ name: item.name, meta: `${item.state} · ${item.meta}`, available: item.state === "已安装" }));

/** 描述「ModuleUpdater」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ModuleUpdater = (module: DemoContextModule) => DemoContextModule;

/** 渲染「AgentStrategyFields」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function AgentStrategyFields({ configuration, prompt, onPatch, rawTitle = "模型适配层原文预览", skillOptions = defaultSkillOptions, skillInstallSlot }: {
  configuration: AgentStrategyConfiguration;
  prompt: string;
  onPatch: (moduleId: ContextModuleId, updater: ModuleUpdater) => void;
  rawTitle?: string;
  skillOptions?: StrategyOption[];
  skillInstallSlot?: ReactNode;
}) {
  return <>
    <div className="mk-context-module-list">
      {configuration.modules.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(module) => <details className={`mk-context-module ${module.enabled ? "enabled" : ""}`} key={module.id} open={module.id === "system"}>
        <summary>
          <label onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
(event) => event.stopPropagation()}>
            <input checked={module.enabled} disabled={configuration.locked} type="checkbox" onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(event) => {
              const enabled = event.target.checked;
              onPatch(module.id, /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(current) => ({ ...current, enabled }));
            }} />
            <span aria-hidden="true" />
          </label>
          <div><strong>{module.title}</strong><small>{module.detail}</small></div>
          <span>{moduleTokenLabel(module)}</span>
          <ChevronDown size={14} />
        </summary>
        <ModuleEditor configuration={configuration} module={module} onPatch={onPatch} skillOptions={skillOptions} skillInstallSlot={skillInstallSlot} />
      </details>)}
    </div>
    <details className="mk-context-raw-preview">
      <summary><span><History size={13} />{rawTitle}</span><ChevronDown size={14} /></summary>
      <pre>{modelPayload(configuration, prompt)}</pre>
    </details>
  </>;
}

/** 渲染「ModuleEditor」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function ModuleEditor({ configuration, module, onPatch, skillOptions, skillInstallSlot }: {
  configuration: AgentStrategyConfiguration;
  module: DemoContextModule;
  onPatch: (moduleId: ContextModuleId, updater: ModuleUpdater) => void;
  skillOptions: StrategyOption[];
  skillInstallSlot?: ReactNode;
}) {
  if (module.id === "mcp") {
    const saved = typeof sessionStorage === "undefined" ? [] : loadSavedMcps(sessionStorage);
    const installations = mergeMcpInstallations(saved, demoMcpInstallations, typeof sessionStorage === "undefined" ? [] : loadRemovedMcpIds(sessionStorage));
    return <div className="mk-context-option-panel mk-context-mcp-picker">
      <div className="mk-context-mcp-note"><span><Server size={13} /><span><strong>从“我的 MCPs”授权给这个 Agent</strong><small>只会向模型注册已勾选且连接可用的 Tool Schema；未选 MCP 即使已安装也不能调用。</small></span></span><a href="/demo/me?tab=mcps">管理 MCP<ExternalLink size={11} /></a></div>
      <div className="mk-context-option-grid">{installations.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(installation) => {
        const checked = module.selectedItems?.includes(installation.id) ?? false;
        const available = installation.state === "ready";
        const toolCount = installation.capabilities.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(capability) => capability.kind === "tool").length;
        return <label className={!available ? "unavailable" : ""} key={installation.id}><input checked={checked} disabled={configuration.locked || !module.enabled || !available} type="checkbox" onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(event) => {
          const nextChecked = event.target.checked;
          onPatch(module.id, /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(current) => updateSelectedItems(
            current,
            nextChecked ? [...(current.selectedItems ?? []), installation.id] : (current.selectedItems ?? []).filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item !== installation.id),
          ));
        }} /><span><strong>{installation.name}</strong><small>{mcpStateLabel(installation.state)} · {toolCount} Tools · {installation.authKind === "bearer" ? <><KeyRound size={9} /> Bearer</> : "无需鉴权"}</small></span></label>;
      })}</div>
    </div>;
  }
  if (module.id === "tools" || module.id === "skills") {
    const options = module.id === "tools" ? toolOptions : skillOptions;
    return <div className="mk-context-option-panel">{module.id === "skills" && skillInstallSlot}<div className="mk-context-option-grid">{options.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(option) => {
      const checked = module.selectedItems?.includes(option.name) ?? false;
      return <label className={!option.available ? "unavailable" : ""} key={option.name}><input checked={checked} disabled={configuration.locked || !module.enabled || !option.available} type="checkbox" onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(event) => {
        const nextChecked = event.target.checked;
        onPatch(module.id, /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(current) => updateSelectedItems(
          current,
          nextChecked ? [...(current.selectedItems ?? []), option.name] : (current.selectedItems ?? []).filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item !== option.name),
        ));
      }} /><span><strong>{option.name}</strong><small>{option.meta}</small></span></label>;
    })}</div></div>;
  }
  if (module.id === "history") return <div className="mk-context-history-control">
    <label>保留最近
      <select disabled={configuration.locked || !module.enabled} value={module.historyTurns ?? 6} onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(event) => {
        const turns = Number(event.target.value);
        onPatch(module.id, /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(current) => ({
          ...current,
          historyTurns: turns,
          value: current.tokens === null ? `运行时保留最近 ${turns} 轮对话` : `最近 ${turns} 轮对话`,
          tokens: current.tokens === null ? null : turns * 27,
        }));
      }}>
        {[2, 4, 6, 10].map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(turns) => <option key={turns} value={turns}>{turns} 轮</option>)}
      </select>
    </label>
    <small>{module.tokens === null ? "这是裁剪策略，不是当前对话内容；Token 将在具体 Turn 组装时计算。" : "基于历史 Turn 快照估算；修改轮数后会重新计算该版本。"}</small>
  </div>;
  return <div className="mk-context-text-editor">
    <textarea disabled={configuration.locked || !module.enabled} rows={module.id === "system" ? 4 : 3} value={module.value} onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(event) => {
      const value = event.target.value;
      onPatch(module.id, /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(current) => ({ ...current, value }));
    }} />
    <small>{configuration.locked ? "这是历史 Turn 的模型输入快照。" : "Demo 会把这里的内容作为当前模型适配层输入。"}</small>
  </div>;
}
