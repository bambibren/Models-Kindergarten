import { useMemo, useState } from "react";
import {
  ArrowLeft,
  Blocks,
  Check,
  ChevronDown,
  CircleAlert,
  Eye,
  EyeOff,
  KeyRound,
  Link2,
  Power,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Wrench,
} from "lucide-react";
import { demoAgentStrategies, demoMcpInstallations } from "../demo-data.js";
import type { DemoMcpAuthKind, DemoMcpCapability, DemoMcpConnectionState, DemoMcpInstallation } from "../demo-types.js";
import { loadSavedAgents, mergeAgentStrategies, saveAgent } from "../agent-editor/agent-storage.js";
import { updateSelectedItems } from "../context-lab/context-lab-state.js";
import { DemoTopNav } from "../shared/DemoTopNav.js";
import { boundMcpIds, loadRemovedMcpIds, loadSavedMcps, mcpStateLabel, mergeMcpInstallations, removeMcp, saveMcp } from "./mcp-demo-state.js";
import "./mcp-editor.css";

type TestState = "idle" | "testing" | "success" | "failed";

const discoveredCapabilities: DemoMcpCapability[] = [
  { name: "search_items", kind: "tool", description: "按关键词搜索远程数据", readOnly: true },
  { name: "read_item", kind: "tool", description: "读取指定数据项", readOnly: true },
  { name: "create_item", kind: "tool", description: "创建新的数据项" },
];

/** 渲染「McpEditorPage」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function McpEditorPage() {
  const query = useMemo(/** 缓存「query」的派生计算，依赖变化时重新生成以避免陈旧闭包。 */
() => new URLSearchParams(location.search), []);
  const mcpId = query.get("mcpId");
  const [installations, setInstallations] = useState(/** 执行「[installations, setInstallations]」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => mergeMcpInstallations(loadSavedMcps(sessionStorage), demoMcpInstallations, loadRemovedMcpIds(sessionStorage)));
  const source = installations.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(installation) => installation.id === mcpId);
  return <main className="mk-demo-app mk-mcp-editor-page">
    <DemoTopNav active="me" />
    {source ? <McpDetail installation={source} onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(next) => {
      saveMcp(sessionStorage, next);
      setInstallations(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(current) => current.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.id === next.id ? next : item));
    }} onRemove={/** 处理「onRemove」事件，校验归属后再推进状态且避免重复提交。 */
() => {
      removeMcp(sessionStorage, source.id);
      mergeAgentStrategies(loadSavedAgents(sessionStorage), demoAgentStrategies).forEach(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(agent) => {
        if (!boundMcpIds(agent).includes(source.id)) return;
        saveAgent(sessionStorage, {
          ...agent,
          modules: agent.modules.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(module) => module.id === "mcp"
            ? updateSelectedItems(module, (module.selectedItems ?? []).filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(id) => id !== source.id))
            : module),
          updatedAt: "刚刚",
        });
      });
      location.href = "/demo/me?tab=mcps";
    }} /> : <McpCreate />}
  </main>;
}

/** 渲染「McpCreate」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function McpCreate() {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [url, setUrl] = useState("");
  const [authKind, setAuthKind] = useState<DemoMcpAuthKind>("none");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [testState, setTestState] = useState<TestState>("idle");
  const [error, setError] = useState("");

  const valid = name.trim().length > 0
    && url.trim().startsWith("https://")
    && (authKind === "none" || token.trim().length >= 8);

  /** 执行「testConnection」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function testConnection() {
    setError("");
    setTestState("testing");
    window.setTimeout(/** 执行受生命周期约束的定时任务，调用方负责在结束时取消句柄。 */
() => {
      if (!valid || url.includes("invalid")) {
        setError(url.startsWith("https://") ? "Bearer Token 无效或远端返回 401。" : "V1 只接受公开 HTTPS Streamable HTTP 地址。");
        setTestState("failed");
        return;
      }
      setTestState("success");
    }, 720);
  }

  /** 执行「install」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function install() {
    if (testState !== "success") return;
    const normalizedName = name.trim();
    const slug = normalizedName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "remote";
    const id = `mcp-custom-${slug}-${Date.now()}`;
    const installation: DemoMcpInstallation = {
      id,
      name: normalizedName,
      description: description.trim() || "Admin 添加的远程 MCP",
      url: url.trim(),
      transport: "streamable_http",
      authKind,
      ...(authKind === "bearer" ? { credentialHint: `•••• ${token.trim().slice(-4).toUpperCase()}` } : {}),
      state: "ready",
      capabilities: discoveredCapabilities,
      boundAgentIds: [],
      lastCheckedAt: "刚刚",
    };
    saveMcp(sessionStorage, installation);
    location.href = "/demo/me?tab=mcps";
  }

  /** 执行「markDirty」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function markDirty() {
    if (testState !== "idle") setTestState("idle");
    setError("");
  }

  return <div className="mk-mcp-editor-shell">
    <PageHeading title="添加远程 MCP" description="为 Admin 注册一个 Streamable HTTP MCP。安装后仍需在具体 Agent 中勾选，模型才能看到它的能力。" />
    <div className="mk-mcp-create-layout">
      <form className="mk-mcp-form" onSubmit={/** 处理「onSubmit」事件，校验归属后再推进状态且避免重复提交。 */
(event) => { event.preventDefault(); testConnection(); }}>
        <section className="mk-mcp-form-section">
          <header><span>1</span><div><strong>连接配置</strong><small>当前版本只支持 Remote Streamable HTTP</small></div></header>
          <label><span>MCP 名称</span><input aria-label="MCP 名称" autoFocus value={name} placeholder="例如：话本地图" onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(event) => { setName(event.target.value); markDirty(); }} /></label>
          <label><span>用途说明</span><input aria-label="用途说明" value={description} placeholder="说明这个 MCP 向 Agent 提供什么能力" onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(event) => { setDescription(event.target.value); markDirty(); }} /></label>
          <label><span>Streamable HTTP 地址</span><div className="mk-mcp-field-with-icon"><Link2 size={14} /><input aria-label="MCP 地址" inputMode="url" value={url} placeholder="https://example.com/mcp" onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(event) => { setUrl(event.target.value); markDirty(); }} /></div><small>生产环境只允许公开 HTTPS 地址；内网与 localhost 不属于本次 Demo 范围。</small></label>
        </section>

        <section className="mk-mcp-form-section">
          <header><span>2</span><div><strong>认证</strong><small>认证关系属于 Admin，所有 Admin 登录点共享</small></div></header>
          <div className="mk-mcp-auth-options" role="radiogroup" aria-label="认证方式">
            <label className={authKind === "none" ? "selected" : ""}><input checked={authKind === "none"} name="auth" type="radio" onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
() => { setAuthKind("none"); markDirty(); }} /><span><strong>无需认证</strong><small>适用于 DeepWiki 等公开远程 MCP</small></span></label>
            <label className={authKind === "bearer" ? "selected" : ""}><input checked={authKind === "bearer"} name="auth" type="radio" onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
() => { setAuthKind("bearer"); markDirty(); }} /><span><strong>Bearer Token</strong><small>适用于话本地图等账号级私有能力</small></span></label>
          </div>
          {authKind === "bearer" && <label><span>Access Token</span><div className="mk-mcp-token-field"><KeyRound size={14} /><input aria-label="Access Token" autoComplete="off" type={showToken ? "text" : "password"} value={token} placeholder="粘贴由 MCP 服务生成的 Token" onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(event) => { setToken(event.target.value); markDirty(); }} /><button aria-label={showToken ? "隐藏 Token" : "显示 Token"} type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => setShowToken(/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
(value) => !value)}>{showToken ? <EyeOff size={14} /> : <Eye size={14} />}</button></div><small>真实实现中 Token 测试成功后加密绑定 Admin；Demo 不保存输入的 Token 原文。</small></label>}
        </section>

        <footer className="mk-mcp-form-actions">
          <span>{testState === "success" ? <><Check size={13} />连接验证通过</> : "测试只执行 initialize 与能力发现，不代表永久保持连接。"}</span>
          <button className="secondary" disabled={!valid || testState === "testing"} type="submit">{testState === "testing" ? <><RefreshCw className="spinning" size={14} />正在连接</> : <><RefreshCw size={14} />测试连接</>}</button>
          <button disabled={testState !== "success"} type="button" onClick={install}><ShieldCheck size={14} />确认安装</button>
        </footer>
      </form>

      <aside className="mk-mcp-test-panel" aria-live="polite">
        <header><strong>连接与能力发现</strong><small>配置必须通过验证后才能安装</small></header>
        {testState === "idle" && <div className="mk-mcp-test-empty"><Blocks size={22} /><p>填写连接地址和认证信息，然后测试远程 MCP。</p></div>}
        {testState === "testing" && <div className="mk-mcp-test-empty"><RefreshCw className="spinning" size={22} /><p>正在执行 initialize、tools/list、resources/list 和 prompts/list…</p></div>}
        {testState === "failed" && <div className="mk-mcp-test-error"><CircleAlert size={18} /><div><strong>连接失败</strong><p>{error}</p></div></div>}
        {testState === "success" && <CapabilityDiscovery capabilities={discoveredCapabilities} />}
      </aside>
    </div>
  </div>;
}

/** 渲染「McpDetail」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function McpDetail({ installation, onChange, onRemove }: {
  installation: DemoMcpInstallation;
  onChange: (next: DemoMcpInstallation) => void;
  onRemove: () => void;
}) {
  const [runtimeState, setRuntimeState] = useState<DemoMcpConnectionState>(installation.state);
  const [tokenEditor, setTokenEditor] = useState(false);
  const [token, setToken] = useState("");
  const [updating, setUpdating] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const boundAgents = mergeAgentStrategies(loadSavedAgents(sessionStorage), demoAgentStrategies).filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(agent) => boundMcpIds(agent).includes(installation.id));

  /** 执行「reconnect」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function reconnect() {
    setRuntimeState("reconnecting");
    window.setTimeout(/** 执行受生命周期约束的定时任务，调用方负责在结束时取消句柄。 */
() => {
      setRuntimeState("ready");
      onChange({ ...installation, state: "ready", lastCheckedAt: "刚刚" });
    }, 650);
  }

  /** 执行「replaceToken」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function replaceToken() {
    if (token.trim().length < 8) return;
    setUpdating(true);
    window.setTimeout(/** 执行受生命周期约束的定时任务，调用方负责在结束时取消句柄。 */
() => {
      const next = { ...installation, credentialHint: `•••• ${token.trim().slice(-4).toUpperCase()}`, state: "ready" as const, lastCheckedAt: "刚刚" };
      onChange(next);
      setRuntimeState("ready");
      setUpdating(false);
      setToken("");
      setTokenEditor(false);
    }, 650);
  }

  const toolCount = installation.capabilities.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(capability) => capability.kind === "tool").length;
  return <div className="mk-mcp-editor-shell">
    <PageHeading title={installation.name} description={installation.description} />
    <section className="mk-mcp-detail-hero">
      <div><span className="mk-mcp-detail-mark"><Blocks size={19} /></span><div><strong>{installation.name}</strong><small>Admin 安装 · Streamable HTTP</small></div></div>
      <em className={`state-${runtimeState}`}>{mcpStateLabel(runtimeState)}</em>
    </section>

    <div className="mk-mcp-detail-grid">
      <section className="mk-mcp-detail-main">
        <header><strong>连接信息</strong><small>账号级配置对所有 Admin 登录点生效</small></header>
        <dl>
          <div><dt>地址</dt><dd>{installation.url}</dd></div>
          <div><dt>认证</dt><dd>{installation.authKind === "none" ? "无需认证" : `Bearer Token · ${installation.credentialHint ?? "需更新"}`}</dd></div>
          <div><dt>能力</dt><dd>{toolCount} Tools · {installation.capabilities.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.kind === "resource").length} Resources · {installation.capabilities.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.kind === "prompt").length} Prompts</dd></div>
          <div><dt>最近检测</dt><dd>{installation.lastCheckedAt}</dd></div>
        </dl>
        <div className="mk-mcp-detail-actions">
          <button type="button" onClick={reconnect}><RefreshCw size={13} />重新连接</button>
          {installation.authKind === "bearer" && <button type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => setTokenEditor(/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
(value) => !value)}><KeyRound size={13} />更新 Token</button>}
          <button type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => {
            const state = runtimeState === "disabled" ? "ready" : "disabled";
            setRuntimeState(state);
            onChange({ ...installation, state });
          }}><Power size={13} />{runtimeState === "disabled" ? "启用" : "停用"}</button>
        </div>
        {tokenEditor && <div className="mk-mcp-token-update"><label><span>新 Access Token</span><input autoComplete="off" type="password" value={token} placeholder="输入后先验证，再替换原 Token" onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(event) => setToken(event.target.value)} /></label><button disabled={token.trim().length < 8 || updating} type="button" onClick={replaceToken}>{updating ? "正在验证…" : "验证并替换"}</button></div>}
      </section>

      <aside className="mk-mcp-agent-usage">
        <header><strong>Agent 使用关系</strong><small>只有绑定后的能力才进入 Tool Registry</small></header>
        {boundAgents.length > 0 ? <ul>{boundAgents.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(agent) => <li key={agent.id}><span><Wrench size={12} /></span><div><strong>{agent.name}</strong><small>{toolCount} 个远程 Tools 可被声明</small></div></li>)}</ul> : <div className="mk-mcp-no-agent">尚未绑定 Agent。<a href="/demo/agent-editor?mode=create">前往 Agent 配置</a></div>}
      </aside>
    </div>

    <section className="mk-mcp-capability-section"><header><strong>已发现的能力</strong><small>重新连接会刷新该快照</small></header><CapabilityDiscovery capabilities={installation.capabilities} /></section>

    <section className="mk-mcp-danger-zone"><div><strong>卸载 MCP</strong><small>会删除 Admin 的配置、认证和 Agent 绑定；所有登录点同时生效。</small></div>{confirmRemove ? <span><button type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => setConfirmRemove(false)}>取消</button><button className="danger" type="button" onClick={onRemove}>确认卸载</button></span> : <button type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => setConfirmRemove(true)}><Trash2 size={13} />卸载</button>}</section>
  </div>;
}

/** 渲染「PageHeading」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function PageHeading({ title, description }: { title: string; description: string }) {
  return <header className="mk-mcp-page-heading"><a aria-label="返回我的 MCPs" href="/demo/me?tab=mcps"><ArrowLeft size={16} /></a><div><span className="mk-demo-kicker">ADMIN · REMOTE MCP</span><h1>{title}</h1><p>{description}</p></div></header>;
}

/** 渲染「CapabilityDiscovery」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function CapabilityDiscovery({ capabilities }: { capabilities: DemoMcpCapability[] }) {
  const groups = (["tool", "resource", "prompt"] as const).map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(kind) => ({ kind, items: capabilities.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(capability) => capability.kind === kind) }));
  return <div className="mk-mcp-capability-list">{groups.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(group) => <details key={group.kind} open={group.kind === "tool"}>
    <summary><span><strong>{group.kind === "tool" ? "Tools" : group.kind === "resource" ? "Resources" : "Prompts"}</strong><small>{group.items.length} 项</small></span><ChevronDown size={13} /></summary>
    <div>{group.items.length > 0 ? group.items.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(capability) => <article key={capability.name}><span><Wrench size={12} /></span><div><strong>{capability.name}</strong><small>{capability.description}</small></div><em>{capability.readOnly ? "只读" : "需确认"}</em></article>) : <p>没有发现此类能力。</p>}</div>
  </details>)}</div>;
}
