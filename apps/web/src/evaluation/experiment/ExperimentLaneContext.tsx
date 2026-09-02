import { ChevronDown } from "lucide-react";

/** 原始回答卡片标题即上下文配置 disclosure；配置默认收起且保持原始快照字段。 */
export function ExperimentLaneContext({ configuration, label, status, subtitle }: {
  configuration: unknown;
  label: "A" | "B" | "C";
  status: string;
  subtitle: string;
}) {
  return <details className="lane-context-disclosure">
    <summary className="lane-card-header">
      <span>{label}</span>
      <div><strong>Test {label}</strong><small>{subtitle} · 点击查看完整上下文配置</small></div>
      <span className="lane-context-state"><em>{status}</em><ChevronDown size={13} /></span>
    </summary>
    <section className="lane-context-config">
      <header><strong>完整上下文配置</strong><small>来自 Experiment Test 与 prepare-run 冻结快照；不包含 Secret。</small></header>
      <pre>{JSON.stringify(configuration, null, 2)}</pre>
    </section>
  </details>;
}
