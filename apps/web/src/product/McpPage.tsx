import { ArrowLeft, Blocks, Check, Power, RefreshCw, Trash2, Wrench } from "lucide-react";
import { useCallback, useState, type FormEvent } from "react";
import type { McpInstallationView, McpTestRecord } from "@kindergarten/contracts";
import { controlApi } from "../api/control-api.js";
import { ErrorState, LoadingState } from "./LoadState.js";
import { ProductNav } from "./ProductNav.js";
import { useResource } from "./use-resource.js";

/** 渲染「McpPage」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function McpPage({ mcpId }: { mcpId?: string }) {
  const load = useCallback(/** 缓存「load」的派生计算，依赖变化时重新生成以避免陈旧闭包。 */
async () => {
    if (!mcpId) return undefined;
    return (await controlApi.mcps()).find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.mcpInstallationId === mcpId);
  }, [mcpId]);
  const { state, retry } = useResource(load);
  return <main className="product-page"><ProductNav active="me" />{!mcpId ? <McpCreate /> : state.phase === "loading" ? <LoadingState label="正在读取 MCP" /> : state.phase === "error" ? <ErrorState {...state} retry={retry} /> : state.data ? <McpDetail value={state.data} retry={retry} /> : <div className="product-state"><strong>MCP 不存在</strong><a href="/me?tab=mcps">返回</a></div>}</main>;
}

/** 渲染「McpCreate」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function McpCreate() {
  const [name, setName] = useState(""); const [url, setUrl] = useState("");
  const [test, setTest] = useState<McpTestRecord | null>(null); const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  /** 执行「testConnection」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async function testConnection(event: FormEvent) { event.preventDefault(); setBusy(true); setMessage(""); try { const value = await controlApi.testMcp({ name: name.trim(), transport: "streamable_http", url: url.trim(), auth: { kind: "none" } }); setTest(value); if (value.state === "failed") setMessage(value.error?.message ?? "连接失败"); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); setTest(null); } finally { setBusy(false); } }
  /** 执行「install」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async function install() { if (!test || test.state !== "succeeded") return; setBusy(true); try { await controlApi.installMcp(test.testId, name.trim()); location.href = "/me?tab=mcps"; } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); setBusy(false); } }
  return <div className="product-editor-shell"><header className="product-page-heading"><a href="/me?tab=mcps"><ArrowLeft size={16} /></a><div><span>ACCOUNT · REMOTE MCP</span><h1>添加远程 MCP</h1><p>首版只支持无需鉴权的 Streamable HTTP；Bearer Token 与小说 MCP 均留白。</p></div></header><div className="product-mcp-layout"><form className="product-form" onSubmit={testConnection}><section><header><Blocks size={16} /><div><strong>连接配置</strong><small>先测试，再安装</small></div></header><label><span>MCP 名称</span><input required value={name} onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(event) => { setName(event.target.value); setTest(null); }} /></label><label><span>Streamable HTTP 地址</span><input required inputMode="url" placeholder="https://example.com/mcp" value={url} onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(event) => { setUrl(event.target.value); setTest(null); }} /></label><label><span>认证</span><input disabled value="无需认证（none）" /></label></section><footer><span>{message || (test?.state === "succeeded" ? "连接验证通过，可以安装。" : "测试会执行 initialize 与能力发现。")}</span><button disabled={busy} type="submit"><RefreshCw size={14} />{busy ? "测试中" : "测试连接"}</button><button disabled={busy || test?.state !== "succeeded"} type="button" onClick={/** 仅在连接体检成功后确认安装，避免提交未经验证的 MCP 配置。 */ () => void install()}><Check size={14} />确认安装</button></footer></form><aside className="product-discovery"><header><strong>能力发现</strong><small>真实连接快照</small></header>{!test ? <div className="product-state"><Blocks size={20} /><p>等待测试连接。</p></div> : test.state === "failed" ? <div className="product-state error"><strong>连接失败</strong><p>{test.error?.message}</p></div> : <CapabilityList snapshot={test.snapshot} />}</aside></div></div>;
}

/** 渲染「McpDetail」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function McpDetail({ value, retry }: { value: McpInstallationView; retry: () => void }) {
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  /** 执行「action」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async function action(name: "enable" | "disable" | "reconnect") { setBusy(true); setMessage(""); try { await controlApi.mcpAction(value.mcpInstallationId, name); retry(); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } }
  /** 释放或删除「remove」对应资源，重复调用仍保持安全。 */
async function remove() { if (value.deletable !== true || !confirm(`卸载 ${value.name}？服务端会重新计算并移除当前 Agent 绑定。`)) return; setBusy(true); try { await controlApi.removeMcp(value.mcpInstallationId); location.href = "/me?tab=mcps"; } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); setBusy(false); } }
  return <div className="product-editor-shell"><header className="product-page-heading"><a href="/me?tab=mcps"><ArrowLeft size={16} /></a><div><span>ACCOUNT · REMOTE MCP</span><h1>{value.name}</h1><p>{value.url}</p></div></header><section className="product-detail-card"><header><div><Blocks size={18} /><span><strong>{value.name}</strong><small>Streamable HTTP · auth {value.authKind}</small></span></div><em>{value.state}</em></header><dl><div><dt>地址</dt><dd>{value.url}</dd></div><div><dt>状态</dt><dd>{value.state}</dd></div><div><dt>能力版本</dt><dd>{value.snapshot?.generation ?? 0}</dd></div><div><dt>最近连接</dt><dd>{value.lastConnectedAt ?? "尚未连接"}</dd></div></dl><div className="product-detail-actions"><button disabled={busy} type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => void action("reconnect")}><RefreshCw size={13} />重新连接</button><button disabled={busy} type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => void action(value.enabled ? "disable" : "enable")}><Power size={13} />{value.enabled ? "停用" : "启用"}</button>{value.deletable === true && <button className="danger" disabled={busy} type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => void remove()}><Trash2 size={13} />卸载</button>}</div>{message && <p className="product-error-text">{message}</p>}</section><section className="product-panel"><header><div><strong>已发现能力</strong><small>重新连接会刷新这一快照</small></div></header><CapabilityList snapshot={value.snapshot} /></section></div>;
}
/** 渲染「CapabilityList」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function CapabilityList({ snapshot }: { snapshot?: McpInstallationView["snapshot"] }) { if (!snapshot) return <div className="product-empty">没有可用快照</div>; return <div className="product-capability-list"><section><strong>Tools · {snapshot.tools.length}</strong>{snapshot.tools.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => <article key={item.name}><Wrench size={12} /><span><strong>{item.name}</strong><small>{item.description ?? "无说明"}</small></span></article>)}</section><section><strong>Resources · {snapshot.resources.length}</strong>{snapshot.resources.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => <article key={item.uri}><Blocks size={12} /><span><strong>{item.name ?? item.uri}</strong><small>{item.uri}</small></span></article>)}</section><section><strong>Prompts · {snapshot.prompts.length}</strong>{snapshot.prompts.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => <article key={item.name}><Blocks size={12} /><span><strong>{item.name}</strong><small>{item.description ?? "无说明"}</small></span></article>)}</section></div>; }
