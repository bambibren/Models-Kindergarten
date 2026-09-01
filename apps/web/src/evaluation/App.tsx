import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  BrainCircuit,
  Check,
  ChevronDown,
  CircleSlash2,
  Clock3,
  CopyX,
  Gauge,
  Layers3,
  ShieldCheck,
  TerminalSquare,
  Wrench,
  X,
} from "lucide-react";
import type {
  MinimalTurnEvaluationResult,
  ModelRoundTrace,
  ToolCallTrace,
  TurnEvaluationRecord,
} from "@kindergarten/evaluation-contract";
import { loadTurnEvaluation } from "./api.js";
import { buildRuntimeTree } from "./runtime-tree.js";
import { AgentEvaluationDemoPage } from "./demo/agent-evaluation/AgentEvaluationDemoPage.js";
import { DemoArtifactPage } from "./demo/agent-evaluation/DemoArtifactPage.js";
import { ExperimentEvaluationPage } from "./experiment/ExperimentEvaluationPage.js";
import "./styles.css";

type PageRoute =
  | { kind: "turn"; sessionId: string; turnId: string }
  | { kind: "agent-evaluation-demo" }
  | { kind: "agent-evaluation-demo-artifact"; artifactId: string }
  | { kind: "experiment"; experimentId: string };

type PageState =
  | { phase: "loading" }
  | { phase: "ready"; record: TurnEvaluationRecord }
  | { phase: "not_found" }
  | { phase: "error"; message: string };

/** 渲染「App」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export default function App() {
  const route = useMemo(readRoute, []);
  const [state, setState] = useState<PageState>({ phase: "loading" });

  useEffect(/** 同步组件生命周期内的外部状态，并在清理阶段释放订阅或临时资源。 */
() => {
    if (!route) {
      setState({ phase: "error", message: "页面地址缺少 sessionId 或 turnId" });
      return;
    }
    if (route.kind === "agent-evaluation-demo") return;
    if (route.kind === "agent-evaluation-demo-artifact") return;
    if (route.kind === "experiment") return;
    let disposed = false;
    void loadTurnEvaluation(route.sessionId, route.turnId)
      .then(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
(record) => {
        if (!disposed) setState(record ? { phase: "ready", record } : { phase: "not_found" });
      })
      .catch(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
(error: unknown) => {
        if (!disposed) setState({ phase: "error", message: errorText(error) });
      });
    return /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */ () => { disposed = true; };
  }, [route]);

  if (route?.kind === "agent-evaluation-demo") return <AgentEvaluationDemoPage />;
  if (route?.kind === "agent-evaluation-demo-artifact") return <DemoArtifactPage artifactId={route.artifactId} />;
  if (route?.kind === "experiment") return <ExperimentEvaluationPage experimentId={route.experimentId} />;
  if (state.phase === "loading") return <CenteredState title="正在读取本轮评测" detail="等待 Runtime Trace 完成上传…" />;
  if (state.phase === "not_found") return <CenteredState title="尚未生成本轮评测" detail="该 Turn 可能仍在后台写入，或 Evaluation 模块当前不可用。" />;
  if (state.phase === "error") return <CenteredState title="无法打开评测" detail={state.message} failed />;
  return <TurnEvaluationPage record={state.record} />;
}

/** 渲染「TurnEvaluationPage」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function TurnEvaluationPage({ record }: { record: TurnEvaluationRecord }) {
  const { trace, result } = record;
  const tree = buildRuntimeTree(trace);
  return <main className="evaluation-shell">
    <header className="evaluation-header">
      <button type="button" className="back-button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => history.back()} aria-label="返回聊天">
        <ArrowLeft size={17} />
      </button>
      <div className="header-copy">
        <span>TURN EVALUATION</span>
        <h1>本轮运行评测</h1>
      </div>
      <div className={`status-pill ${trace.status}`}>
        {trace.status === "completed" ? <Check size={13} /> : <X size={13} />}
        {statusText(trace.status)}
      </div>
    </header>

    <section className="identity-strip">
      <div><span>Session</span><code>{shortId(trace.sessionId)}</code></div>
      <div><span>Turn</span><code>{shortId(trace.turnId)}</code></div>
      <div><span>ModelStudent</span><strong>{trace.variant.studentName}</strong></div>
      <div><span>Model</span><strong>{trace.variant.model}</strong></div>
    </section>

    <section className="metrics-section">
      <div className="section-heading"><Gauge size={17} /><div><h2>最小评分集</h2><p>直接从本轮 Runtime Trace 计算，不含 Judge 或综合权重。</p></div></div>
      <MetricsGrid result={result} />
    </section>

    <section className="runtime-section">
      <div className="section-heading"><TerminalSquare size={17} /><div><h2>Runtime 执行</h2><p>按 Model Round 和 Tool 开始位置组织，完成先后不会重排。</p></div></div>
      <div className="runtime-tree">
        {tree.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
({ round, tools }) => <RoundNode key={round.id} round={round} tools={tools} turnStartedAt={trace.startedAt} />)}
        <div className={`terminal-node ${trace.status}`}>
          <span>{trace.status === "completed" ? <Check size={14} /> : <X size={14} />}</span>
          <div><strong>Prompt Turn {statusText(trace.status)}</strong><small>{trace.stopReason ?? "无 stopReason"} · {formatDuration(trace.completedAt - trace.startedAt)}</small></div>
        </div>
      </div>
    </section>

    {trace.errors.length > 0 && <section className="errors-section">
      <div className="section-heading"><AlertTriangle size={17} /><div><h2>错误</h2><p>Runtime 和模型执行期间记录的错误事实。</p></div></div>
      {trace.errors.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(error, index) => <div className="error-row" key={`${error.at}:${index}`}>
        <strong>{error.scope}</strong><span>{error.message}</span>
      </div>)}
    </section>}
  </main>;
}

/** 渲染「MetricsGrid」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function MetricsGrid({ result }: { result: MinimalTurnEvaluationResult }) {
  const items = [
    { label: "正常完成", value: result.normallyCompleted ? "是" : "否", icon: result.normallyCompleted ? Check : X, tone: result.normallyCompleted ? "normal" : "danger" },
    { label: "Model Rounds", value: String(result.modelRoundCount), icon: BrainCircuit },
    { label: "Tool Calls", value: String(result.toolCallCount), icon: Wrench },
    { label: "Tool 成功 / 失败", value: `${result.toolSuccessCount} / ${result.toolFailureCount}`, icon: TerminalSquare },
    { label: "重复 Tool 请求", value: result.hasRepeatedToolCall ? "有" : "无", icon: CopyX, tone: result.hasRepeatedToolCall ? "danger" : "normal" },
    { label: "Context Tokens", value: formatNumber(result.totalContextTokens), icon: Layers3 },
    { label: "截断上下文", value: String(result.truncatedContextItemCount), icon: CircleSlash2 },
    { label: "首 Token 延迟", value: result.firstTokenLatencyMs === undefined ? "未提供" : formatDuration(result.firstTokenLatencyMs), icon: Clock3 },
    { label: "总耗时", value: formatDuration(result.totalDurationMs), icon: Clock3 },
    { label: "Output Tokens", value: formatNumber(result.totalOutputTokens), icon: Gauge },
    { label: "错误数量", value: String(result.errorCount), icon: AlertTriangle, tone: result.errorCount > 0 ? "danger" : "normal" },
    { label: "权限违规", value: String(result.permissionViolationCount), icon: ShieldCheck, tone: result.permissionViolationCount > 0 ? "danger" : "normal" },
  ] as const;
  return <div className="metrics-grid">{items.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => {
    const Icon = item.icon;
    return <article className={`metric-card ${"tone" in item ? item.tone : ""}`} key={item.label}>
      <div><Icon size={15} /><span>{item.label}</span></div><strong>{item.value}</strong>
    </article>;
  })}</div>;
}

/** 渲染「RoundNode」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function RoundNode({ round, tools, turnStartedAt }: {
  round: ModelRoundTrace;
  tools: ToolCallTrace[];
  turnStartedAt: number;
}) {
  const contextTokens = round.context.inputTokens ?? round.context.messages.reduce(/** 把当前元素归并到有限累加状态，避免额外复制完整集合。 */
(sum, item) => sum + item.estimatedTokens, 0);
  return <article className="round-node">
    <div className="round-marker"><BrainCircuit size={15} /></div>
    <div className="round-card">
      <div className="round-heading"><div><strong>Model Round {round.index + 1}</strong><span>{formatNumber(contextTokens)} context tokens</span></div><small>{round.firstTokenAt ? `TTFT ${formatDuration(round.firstTokenAt - turnStartedAt)}` : "未提供 TTFT"}</small></div>

      <details className="trace-details">
        <summary><Layers3 size={13} />Context Assembly <ChevronDown size={13} /></summary>
        <div className="context-list">{round.context.messages.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(message, index) => <div className="context-row" key={`${message.sourceId ?? message.source}:${index}`}>
          <div><span className={`role role-${message.role}`}>{message.role}</span><strong>{sourceText(message.source)}</strong><small>{message.estimatedTokens} est. tokens</small></div>
          <pre>{`正文未进入 Trace · ${message.byteLength} bytes · sha256 ${message.contentHash}`}</pre>
        </div>)}</div>
      </details>

      {round.output?.thinking && <details className="trace-details">
        <summary><BrainCircuit size={13} />模型思考输出 <ChevronDown size={13} /></summary>
        <pre>{evidenceText(round.output.thinking)}</pre>
      </details>}

      {tools.length > 0 && <div className="tool-list">{tools.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(tool) => <ToolNode key={tool.toolCallId} tool={tool} />)}</div>}

      {round.output?.text && <div className="round-output"><span>模型输出证据</span><p>{evidenceText(round.output.text)}</p></div>}
      <div className="round-footer"><span>{round.stopReason ?? "未结束"}</span><span>{round.outputTokens ?? 0} output tokens</span><span>{round.completedAt ? formatDuration(round.completedAt - round.startedAt) : "未完成"}</span></div>
    </div>
  </article>;
}

/** 渲染「ToolNode」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function ToolNode({ tool }: { tool: ToolCallTrace }) {
  return <details className={`tool-node status-${tool.status ?? "pending"}`}>
    <summary><span className="tool-icon"><Wrench size={13} /></span><strong>{tool.name}</strong><small>{toolStatusText(tool.status)}</small><ChevronDown size={13} /></summary>
    <div className="tool-body"><div><span>输入</span><pre>{pretty(tool.arguments)}</pre></div><div><span>输出</span><pre>{tool.output === undefined ? "无输出" : pretty(tool.output)}</pre></div>{tool.error && <div className="tool-error"><span>{tool.error.category}</span><p>{tool.error.message}</p></div>}</div>
  </details>;
}

/** Trace V2 只展示不可逆摘要，避免评测页面重新承载模型正文和工具原始结果。 */
function evidenceText(value: { sha256: string; bytes: number }): string {
  return `${value.bytes} bytes · sha256 ${value.sha256}`;
}

/** 渲染「CenteredState」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function CenteredState({ title, detail, failed = false }: { title: string; detail: string; failed?: boolean }) {
  return <main className="centered-state"><div className={failed ? "failed" : ""}>{failed ? <AlertTriangle size={20} /> : <Gauge size={20} />}<h1>{title}</h1><p>{detail}</p><button type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => history.back()}><ArrowLeft size={14} />返回</button></div></main>;
}

/** 读取「readRoute」所需数据，并遵守作用域、分页与容量边界。 */
function readRoute(): PageRoute | null {
  const demoArtifact = location.pathname.match(/^\/evaluation\/demo\/agent-comparison\/artifacts\/([^/]+)\/?$/)?.[1];
  if (demoArtifact) return { kind: "agent-evaluation-demo-artifact", artifactId: decodeURIComponent(demoArtifact) };
  if (/^\/evaluation\/demo\/agent-comparison\/?$/.test(location.pathname)) {
    return { kind: "agent-evaluation-demo" };
  }
  const experiment = location.pathname.match(/^\/evaluation\/experiments\/([^/]+)\/?$/)?.[1];
  if (experiment) return { kind: "experiment", experimentId: decodeURIComponent(experiment) };
  const match = location.pathname.match(/^\/evaluation\/sessions\/([^/]+)\/turns\/([^/]+)\/?$/);
  return match?.[1] && match[2]
    ? { kind: "turn", sessionId: decodeURIComponent(match[1]), turnId: decodeURIComponent(match[2]) }
    : null;
}

/** 执行「statusText」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function statusText(status: "completed" | "failed" | "cancelled"): string {
  if (status === "completed") return "已完成";
  if (status === "cancelled") return "已取消";
  return "失败";
}

/** 根据已校验输入构建「toolStatusText」结果，不额外持有调用方的大对象。 */
function toolStatusText(status: ToolCallTrace["status"]): string {
  if (status === "success") return "成功";
  if (status === "error") return "失败";
  if (status === "denied") return "已拒绝";
  if (status === "duplicate_blocked") return "重复已阻止";
  return "未完成";
}

/** 执行「sourceText」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function sourceText(source: string): string {
  return ({ system: "System Prompt", session_history: "会话历史", current_turn: "当前 Turn", tool_result: "Tool Result", memory: "Memory", retrieval: "Retrieval", summary: "Summary" } as Record<string, string>)[source] ?? source;
}

/** 执行「formatDuration」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function formatDuration(milliseconds: number): string {
  return milliseconds < 1_000 ? `${Math.round(milliseconds)} ms` : `${(milliseconds / 1_000).toFixed(2)} s`;
}

/** 执行「formatNumber」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function formatNumber(value: number): string { return new Intl.NumberFormat("zh-CN").format(value); }
/** 由规范字段生成稳定的「shortId」标识，供索引精确定位且不保留原始大对象。 */
function shortId(value: string): string { return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value; }
/** 执行「pretty」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function pretty(value: unknown): string { return JSON.stringify(value, null, 2) ?? String(value); }
/** 把未知异常转换为「errorText」文本，避免错误序列化过程再次抛出。 */
function errorText(value: unknown): string { return value instanceof Error ? value.message : String(value); }
