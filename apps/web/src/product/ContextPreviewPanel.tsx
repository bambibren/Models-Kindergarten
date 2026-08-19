import { Braces, RefreshCw } from "lucide-react";
import type { ContextPreviewResponseV2, ContextSummaryItem } from "@kindergarten/contracts";

export function ContextPreviewPanel({ value, loading = false, error = "", onRefresh }: {
  value?: ContextPreviewResponseV2 | undefined;
  loading?: boolean | undefined;
  error?: string | undefined;
  onRefresh: () => void;
}) {
  const items = value?.contextSummary.items.filter(isVisibleItem) ?? [];
  const inputBytes = value?.providerInputBytes ?? 0;
  return <section className="product-context-preview">
    <header>
      <div><Braces size={16} /><span><strong>实际模型上下文（只读）</strong><small>由目标 ModelStudent 的真实 Runtime 与 serializer 生成</small></span></div>
      <button disabled={loading} type="button" onClick={onRefresh}><RefreshCw size={13} />{loading ? "生成中" : "刷新"}</button>
    </header>
    {error && <p className="product-context-preview-error">{error}</p>}
    {value?.diagnostics.map((item) => <p className="product-context-preview-error" key={`${item.code}:${item.path ?? ""}`}>{item.message}</p>)}
    {!value && !error ? <p className="product-context-preview-empty">{loading ? "正在生成当前版本的真实上下文…" : "等待生成真实上下文。"}</p> : <>
      <div className="product-context-preview-facts">
        <span>约 {value?.contextSummary.totalEstimatedTokens ?? 0} tokens</span>
        <span>{items.length} 个可见来源</span>
        <span>{inputBytes} bytes Provider input</span>
        <span>{value?.runnable ? "预检可运行" : "预检未通过"}</span>
      </div>
      {value && <div className="product-context-preview-model">
        <span><strong>{value.model.displayName}</strong><small>{value.model.providerKind} · {value.model.model}</small></span>
        <span><strong>推理：{value.resolvedReasoning.requestedProfile} → {value.resolvedReasoning.resolvedProfile}</strong><small>{JSON.stringify(value.resolvedReasoning.native)}</small></span>
        <span><strong>{historyLabel(value.history.configuredPolicy)}</strong><small>本次是全新实验 Session，实际进入历史为 0；此项只帮助理解 Agent 配置，不影响测试结果。</small></span>
      </div>}
      <div className="product-context-preview-items">{items.map((item) => <ContextPreviewItem item={item} key={item.id} />)}</div>
      {value && <details className="product-context-preview-provider"><summary><span><strong>Provider 首轮序列化输入</strong><small>{value.providerInput.provider} · {value.providerInput.model}</small></span><em>{value.providerInputBytes} bytes</em></summary><pre>{value.providerInput.value}</pre></details>}
    </>}
  </section>;
}

function historyLabel(policy: ContextPreviewResponseV2["history"]["configuredPolicy"]): string {
  return policy.mode === "recent_turns"
    ? `Agent 历史策略：最近 ${policy.maxTurns} 个完整 Turn（只读）`
    : "Agent 历史策略：不带历史（只读）";
}

function ContextPreviewItem({ item }: { item: ContextSummaryItem }) {
  return <details open={item.kind === "system_instruction"}>
    <summary>
      <span><strong>{item.kind === "system_instruction" ? "最终系统指令" : item.title}</strong><small>{contextKindLabel(item.kind)}{item.detail ? ` · ${item.detail}` : ""}</small></span>
      <em>{item.itemCount !== undefined ? `${item.itemCount} 项 · ` : ""}约 {item.estimatedTokens} tokens</em>
    </summary>
    {item.raw ? <pre>{item.raw.value}</pre> : <p>该来源没有可展示的序列化原文。</p>}
  </details>;
}

function isVisibleItem(item: ContextSummaryItem): boolean {
  return item.kind !== "session_history" && item.kind !== "truncated_history";
}

function contextKindLabel(kind: ContextSummaryItem["kind"]): string {
  if (kind === "system_instruction") return "Runtime 合并结果";
  if (kind === "available_tools") return "Tool Schema";
  if (kind === "skill_catalog") return "Skill 目录上下文";
  if (kind === "mcp_resource_catalog") return "MCP Resource 目录";
  if (kind === "mcp_resource") return "MCP 预加载资源";
  return kind;
}
