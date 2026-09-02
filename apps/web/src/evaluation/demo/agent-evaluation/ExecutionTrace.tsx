import { AlertTriangle, BrainCircuit, CheckCircle2, CircleDot, Clock3, LoaderCircle, MessageSquareText, RotateCcw, Wrench } from "lucide-react";
import type { DemoExecution } from "./types.js";
import "./execution-trace.css";

/** Demo 与正式实验页共用同一份 Runtime 指标和轨迹结构。 */
export function ExecutionTrace({ execution }: { execution: DemoExecution }) {
  return <div className="execution-column">
    <div className="execution-metrics">
      <span><Clock3 size={13} /><strong>{execution.duration}</strong><small>总耗时</small></span>
      <span><CircleDot size={13} /><strong>{execution.modelRounds}</strong><small>Rounds</small></span>
      <span className={execution.retryCount > 0 ? "has-retries" : undefined}><RotateCcw size={13} /><strong>{execution.retryCount}</strong><small>模型重试</small></span>
      <span><Wrench size={13} /><strong>{execution.toolCalls}</strong><small>Tools</small></span>
      <span><MessageSquareText size={13} /><strong>{execution.outputTokens}</strong><small>Tokens</small></span>
    </div>
    <ol className="execution-trace">
      {execution.trace.map((item) => <li className={`trace-${item.type} status-${item.status}`} key={item.id}>
        <span className="execution-trace-marker">{item.status === "running"
          ? <LoaderCircle className="execution-trace-spinner" size={12} />
          : item.status === "failed" || item.status === "cancelled"
          ? <AlertTriangle size={12} />
          : item.type === "tool" ? <Wrench size={12} /> : item.type === "model" ? <BrainCircuit size={12} /> : <CheckCircle2 size={12} />}</span>
        <div>
          <header><small>ROUND {item.round} · {traceTypeLabel(item.type)}{item.attemptIndex === undefined ? "" : item.attemptIndex === 0 ? " · 首次调用" : ` · 重试 ${item.attemptIndex}`}</small><strong>{item.title}</strong></header>
          <p>{item.detail}</p>
          <footer><span><Clock3 size={11} />{item.duration}</span><span>{traceStatusLabel(item)}</span></footer>
        </div>
      </li>)}
    </ol>
  </div>;
}

function traceStatusLabel(item: DemoExecution["trace"][number]): string {
  if (item.status === "running") return item.attemptIndex && item.attemptIndex > 0 ? `重试 ${item.attemptIndex} 进行中` : "进行中";
  if (item.status === "failed") return item.retryDelay ? `失败 · ${item.retryDelay} 后重试` : "失败";
  if (item.status === "cancelled") return "已取消";
  if (item.attemptIndex === 0) return "首次调用成功";
  if (item.attemptIndex !== undefined) return `重试 ${item.attemptIndex} 成功`;
  return "已完成";
}

function traceTypeLabel(type: "model" | "tool" | "result"): string {
  if (type === "model") return "MODEL";
  if (type === "tool") return "TOOL";
  return "RESULT";
}
