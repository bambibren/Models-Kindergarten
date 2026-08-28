import * as Collapsible from "@radix-ui/react-collapsible";
import {
  AlertTriangle,
  BookOpen,
  Braces,
  ChevronDown,
  Database,
  MessagesSquare,
  ShieldCheck,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type {
  ContextSummaryItem,
  ContextSummaryKind,
} from "@kindergarten/contracts";
import type { ContextSummaryEntry } from "../../chat/chat-types.js";

const icons: Record<ContextSummaryKind, LucideIcon> = {
  system_instruction: ShieldCheck,
  available_tools: Wrench,
  skill_catalog: BookOpen,
  mcp_resource_catalog: Database,
  mcp_resource: Database,
  session_history: MessagesSquare,
  truncated_history: AlertTriangle,
};

/** 渲染「ContextSummaryEntryView」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function ContextSummaryEntryView({ entry }: { entry: ContextSummaryEntry }) {
  const { items, totalEstimatedTokens } = entry.summary;
  if (items.length === 0) return null;
  return <Collapsible.Root className="context-summary">
    <Collapsible.Trigger className="context-summary-trigger">
      <span className="context-summary-mark"><Braces size={14} /></span>
      <span>上下文提要</span>
      <small>{items.length} 项 · 约 {formatTokens(totalEstimatedTokens)} tokens</small>
      <ChevronDown className="context-summary-chevron" size={14} />
    </Collapsible.Trigger>
    <Collapsible.Content className="context-summary-content">
      <div className="context-summary-panel">
        {items.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => <ContextSummaryRow key={item.id} item={item} />)}
        {/* 上下文实验功能调研期间不暴露“用本轮做实验”的入口。 */}
      </div>
    </Collapsible.Content>
  </Collapsible.Root>;
}

/** 渲染「ContextSummaryRow」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function ContextSummaryRow({ item }: { item: ContextSummaryItem }) {
  const Icon = icons[item.kind];
  const trust = trustLabel(item.trust);
  return <Collapsible.Root className="context-summary-row">
    <Collapsible.Trigger className="context-summary-row-trigger">
      <span className="context-summary-item-icon"><Icon size={14} /></span>
      <span className="context-summary-copy">
        <strong>{item.title}</strong>
        {item.detail && <span title={item.detail}>{item.detail}</span>}
      </span>
      <span className="context-summary-meta">
        {trust && <span>{trust}</span>}
        {item.itemCount !== undefined && <span>{item.itemCount} 项</span>}
        <span>约 {formatTokens(item.estimatedTokens)} tokens</span>
      </span>
      <ChevronDown className="context-summary-row-chevron" size={13} />
    </Collapsible.Trigger>
    <Collapsible.Content className="context-summary-row-content">
      {item.raw
        ? <div className="context-summary-raw">
          <div className="context-summary-raw-meta">
            <span>{item.raw.provider}</span>
            <span>{item.raw.model}</span>
            <span>{item.raw.format.toUpperCase()}</span>
          </div>
          <pre tabIndex={0} aria-label={`${item.title}的模型适配层原文`}>{item.raw.value}</pre>
        </div>
        : <p className="context-summary-raw-empty">
          该历史记录创建时尚未保存模型适配层原文。
        </p>}
    </Collapsible.Content>
  </Collapsible.Root>;
}

/** 执行「formatTokens」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function formatTokens(value: number): string {
  if (value < 1_000) return String(value);
  const scaled = value / 1_000;
  return `${scaled >= 10 ? scaled.toFixed(0) : scaled.toFixed(1)}k`;
}

/** 执行「trustLabel」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function trustLabel(value: ContextSummaryItem["trust"]): string | null {
  if (value === "approved") return "已授权";
  if (value === "untrusted") return "外部数据";
  return null;
}
