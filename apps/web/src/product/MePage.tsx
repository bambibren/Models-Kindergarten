import { Archive, Blocks, Bot, Braces, Download, ExternalLink, FileBox, Plus, RotateCcw, Sparkles, Trash2, UserRound } from "lucide-react";
import { Children, useState } from "react";
import type { SkillSource } from "@kindergarten/contracts";
import { controlApi } from "../api/control-api.js";
import { formatContextWindow, joinMetadata } from "../components/tokens/token-format.js";
import { artifactListLabel } from "./artifact-list-label.js";
import { ErrorState, LoadingState } from "./LoadState.js";
import { ProductNav } from "./ProductNav.js";
import { useAuthSession } from "./auth-session-context.js";
import { useResource } from "./use-resource.js";

type Tab = "artifacts" | "agents" | "models" | "mcps" | "skills";
const tabs: Array<{ id: Tab; label: string; icon: typeof Braces }> = [
  // 上下文实验功能调研期间不展示“我的对照实验”板块。
  { id: "artifacts", label: "我的 Artifacts", icon: FileBox }, { id: "agents", label: "我的 Agents", icon: Braces },
  { id: "models", label: "我的 Models", icon: Bot }, { id: "mcps", label: "我的 MCPs", icon: Blocks }, { id: "skills", label: "我的 Skills", icon: Sparkles },
];
/** 渲染「MePage」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function MePage() {
  const session = useAuthSession();
  const username = session?.principal.username ?? "Account";
  const passwordAccount = session?.principal.kind === "password_user";
  const initial = new URLSearchParams(location.search).get("tab") as Tab | null;
  const [tab, setTab] = useState<Tab>(tabs.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.id === initial) ? initial! : "artifacts");
  /** 执行「select」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function select(next: Tab) { setTab(next); const url = new URL(location.href); url.searchParams.set("tab", next); history.replaceState(null, "", url); }
  return <main className="product-page"><ProductNav active="me" /><div className="product-me-shell"><aside><div><UserRound size={23} /></div><strong>{username}</strong><span>{passwordAccount ? "密码账号" : "本地管理员"}</span><p>{passwordAccount ? "当前账号的数据与其他账号隔离。" : "开发模式使用本地管理员身份。"}</p></aside><section><header><span>ACCOUNT · PERSONAL SPACE</span><h1>我的</h1></header><nav className="product-tabs">{tabs.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => { const Icon = item.icon; return <button className={tab === item.id ? "active" : ""} key={item.id} type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => select(item.id)}><Icon size={14} />{item.label}</button>; })}</nav>
    {/* 各 Tab 返回的数据结构不同；切换时必须重建加载状态，不能让新面板读取上一 Tab 的旧数据。 */}
    <ResourcePanel key={tab} tab={tab} /></section></div></main>;
}
/** 渲染「ResourcePanel」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function ResourcePanel({ tab }: { tab: Tab }) {
  if (tab === "artifacts") return <ResourceLoader load={loadArtifacts}>{/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(data, retry) => <ArtifactList items={data.items} retry={retry} />}</ResourceLoader>;
  if (tab === "agents") return <ResourceLoader load={loadAgents}>{/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(data, retry) => <Panel title="可复用 Agent" action={<a href="/agents/new"><Plus size={13} />创建 Agent</a>}>{data.items.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => <ResourceRow href={`/agents/${item.agentId}`} icon={<Braces size={15} />} key={item.agentId} title={item.name} detail={item.description ?? "未填写说明"} onDelete={item.deletable === true ? /** 处理「onDelete」事件，校验归属后再推进状态且避免重复提交。 */
() => remove(`Agent「${item.name}」`, /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
() => controlApi.removeAgent(item.agentId), retry) : undefined} />)}</Panel>}</ResourceLoader>;
  if (tab === "models") return <ResourceLoader load={loadModels}>{/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(data, retry) => <Panel title="我的 Models" action={<a href="/models/new"><Plus size={13} />新模型入园</a>}>{data.items.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => <ResourceRow icon={<Bot size={15} />} key={item.modelStudentId} title={item.displayName} detail={joinMetadata([formatContextWindow(item.contextWindowTokens), item.model, item.providerKind])} state={item.status === "ready" ? "可用" : "不可用"} onDelete={item.deletable === true ? /** 处理「onDelete」事件，校验归属后再推进状态且避免重复提交。 */
() => remove(`Model「${item.displayName}」`, /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
() => controlApi.removeModel(item.modelStudentId), retry) : undefined} />)}</Panel>}</ResourceLoader>;
  if (tab === "mcps") return <ResourceLoader load={loadMcps}>{/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(data, retry) => <Panel title="我的 MCPs" action={<a href="/mcp/new"><Plus size={13} />添加远程 MCP</a>}>{data.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => <ResourceRow href={`/mcp/${item.mcpInstallationId}`} icon={<Blocks size={15} />} key={item.mcpInstallationId} title={item.name} detail={item.url} state={item.state} onDelete={item.deletable === true ? /** 处理「onDelete」事件，校验归属后再推进状态且避免重复提交。 */
() => remove(`MCP「${item.name}」`, /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
() => controlApi.removeMcp(item.mcpInstallationId), retry) : undefined} />)}</Panel>}</ResourceLoader>;
  return <ResourceLoader load={loadSkills}>{/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(data, retry) => <SkillPanel items={data.items} retry={retry} />}</ResourceLoader>;
}
/** 渲染「ResourceLoader」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function ResourceLoader<T>({ load, children }: { load: () => Promise<T>; children: (data: T, retry: () => void) => React.ReactNode }) {
  const { state, retry } = useResource(load);
  if (state.phase === "loading") return <LoadingState />;
  if (state.phase === "error") return <ErrorState {...state} retry={retry} />;
  return children(state.data, retry);
}
const loadAgents = /** 读取「loadAgents」所需数据，并遵守作用域、分页与容量边界。 */
() => controlApi.agents();
const loadModels = /** 读取「loadModels」所需数据，并遵守作用域、分页与容量边界。 */
() => controlApi.models();
const loadMcps = /** 读取「loadMcps」所需数据，并遵守作用域、分页与容量边界。 */
() => controlApi.mcps();
const loadSkills = /** 读取「loadSkills」所需数据，并遵守作用域、分页与容量边界。 */
() => controlApi.skills();
// 上下文实验功能调研期间不从“我的”加载或展示实验记录。
const loadArtifacts = /** 读取「loadArtifacts」所需数据，并遵守作用域、分页与容量边界。 */
async () => {
  const [artifacts, sessions] = await Promise.all([
    controlApi.artifacts("", "all"),
    controlApi.sessions(),
  ]);
  const sessionTitles = new Map(sessions.items.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(session) => [session.sessionId, session.title]));
  return {
    items: artifacts.items.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(artifact) => ({
      artifact,
      sessionTitle: sessionTitles.get(artifact.sourceSessionId),
    })),
  };
};
/** 渲染「Panel」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function Panel({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) { return <section className="product-panel"><header><div><strong>{title}</strong><small>服务端持久记录</small></div>{action}</header><div className="product-resource-list">{Children.count(children) > 0 ? children : <div className="product-empty">暂无记录</div>}</div></section>; }
/** 渲染「ResourceRow」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function ResourceRow({ icon, title, detail, state, href, onDelete }: { icon: React.ReactNode; title: string; detail: string; state?: string; href?: string; onDelete?: (() => void) | undefined }) {
  const content = <>{icon}<span><strong>{title}</strong><small>{detail}</small></span>{state && <em>{state}</em>}{href && <ExternalLink size={13} />}</>;
  return <div className="product-resource-row-wrap">{href ? <a className="product-resource-row" href={href}>{content}</a> : <article className="product-resource-row">{content}</article>}{onDelete && <button aria-label={`删除 ${title}`} className="product-resource-delete" title="删除" type="button" onClick={onDelete}><Trash2 size={13} /></button>}</div>;
}
/** 释放或删除「remove」对应资源，重复调用仍保持安全。 */
async function remove(label: string, action: () => Promise<unknown>, retry: () => void) {
  if (!confirm(`删除${label}？已有会话和历史记录仍可查看，但不能再用于新任务。`)) return;
  try { await action(); retry(); } catch (error) { alert(error instanceof Error ? error.message : String(error)); }
}
/** 渲染「SkillPanel」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function SkillPanel({ items, retry }: { items: Awaited<ReturnType<typeof controlApi.skills>>["items"]; retry: () => void }) {
  const [url, setUrl] = useState(""); const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  /** 执行「install」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async function install() { setBusy(true); setMessage(""); try { const job = await controlApi.installSkills([url.trim()]); setUrl(""); await followJob(job.jobId); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } }
  /** 执行「followJob」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async function followJob(jobId: string) {
    for (let index = 0; index < 120; index += 1) {
      const job = await controlApi.skillJob(jobId); setMessage(`安装任务：${job.state}`);
      if (["succeeded", "failed", "cancelled", "interrupted"].includes(job.state)) { retry(); return; }
      await new Promise(/** 完成当前异步桥接，并保证每条分支只结算一次。 */
(resolve) => window.setTimeout(resolve, 500));
    }
    setMessage("安装仍在进行，可稍后刷新查看。"); retry();
  }
  return <Panel title="我的 Skills"><div className="product-inline-install"><input aria-label="Skill 安装地址" placeholder="GitHub 或 MK Skill 资源地址" value={url} onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(event) => setUrl(event.target.value)} /><button disabled={busy || !url.trim()} type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => void install()}>{busy ? "正在提交" : "安装"}</button>{message && <small>{message}</small>}</div>{items.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => <ResourceRow icon={<Sparkles size={15} />} key={item.skillInstallationId} title={item.displayName ?? item.skillName ?? "Skill"} detail={skillSourceLabel(item.source)} state={item.state} onDelete={item.deletable === true ? /** 处理「onDelete」事件，校验归属后再推进状态且避免重复提交。 */
() => remove(`Skill「${item.displayName ?? item.skillName ?? "Skill"}」`, /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
() => controlApi.removeSkill(item.skillInstallationId), retry) : undefined} />)}</Panel>;
}

/** 渲染「ArtifactList」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function ArtifactList({ items, retry }: { items: Awaited<ReturnType<typeof loadArtifacts>>["items"]; retry: () => void }) {
  /** 更新「setState」对应状态，并保持写入顺序、原子性与容量约束。 */
async function setState(id: string, action: "archive" | "restore") {
    try { await controlApi.setArtifactState(id, action); retry(); }
    catch (error) { alert(error instanceof Error ? error.message : String(error)); }
  }
  return <Panel title="我的 Artifacts">{items.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
({ artifact: item, sessionTitle }) => {
    const label = artifactListLabel(item.displayName, item.sourceSessionId, sessionTitle, item.version ?? 1);
    return <div className="product-resource-row-wrap artifact-resource-row" key={item.artifactId}>
    <a className="product-resource-row" href={`/artifacts/${encodeURIComponent(item.artifactId)}`}><FileBox size={15} /><span><strong title={label.fullTitle}>{label.title}</strong><small>{label.sessionRef} · {item.kind === "html_bundle" ? "HTML Bundle" : item.primary.mimeType} · {formatBytes(item.primary.byteLength)} · Artifact #{item.artifactId.slice(-8)}</small></span><em>{item.state === "active" ? "可用" : "已归档"}</em><ExternalLink size={13} /></a>
    <span className="artifact-resource-actions">
      <a aria-label={`下载 ${item.displayName}`} href={controlApi.artifactContentUrl(item.artifactId)} title="下载"><Download size={13} /></a>
      <button aria-label={`${item.state === "active" ? "归档" : "恢复"} ${item.displayName}`} title={item.state === "active" ? "归档" : "恢复"} type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => void setState(item.artifactId, item.state === "active" ? "archive" : "restore")}>{item.state === "active" ? <Archive size={13} /> : <RotateCcw size={13} />}</button>
    </span>
  </div>})}</Panel>;
}

/** 执行「formatBytes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

/** 执行「skillSourceLabel」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function skillSourceLabel(source: SkillSource): string {
  if (source.kind === "github_tree") return `${source.repository}/${source.subdirectory}`;
  return source.kind === "resource_bundle" ? source.url : source.sourceId;
}
