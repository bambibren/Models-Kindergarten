import { ArrowLeft, BarChart3, Beaker, BookmarkCheck, BookmarkPlus, Braces, Check, Circle, Highlighter, RefreshCw, Route, ShieldCheck, Wrench } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type * as acp from "@agentclientprotocol/sdk";
import type {
  AnnotationVerdict,
  ExperimentAnnotationWorksheet,
  ExperimentRecord,
  ExperimentScorecard,
  OutputAnnotationFacts,
  PlanningAnnotationFacts,
  UnderstandingAnnotationFacts,
} from "@kindergarten/contracts";
import { experimentApi } from "../experiment-api.js";
import { ExperimentAcpClient } from "../experiment-acp-client.js";
import "./experiment-evaluation.css";

const ACP_URL = import.meta.env.VITE_ACP_URL ?? "ws://127.0.0.1:7331/acp";
type Phase = "loading" | "ready" | "running" | "error";
type Tab = "answers" | "understanding" | "planning" | "output" | "execution" | "summary";
type AnnotationTab = "understanding" | "planning" | "output";

export function ExperimentEvaluationPage({ experimentId }: { experimentId: string }) {
  const [phase, setPhase] = useState<Phase>("loading"); const [error, setError] = useState("");
  const [experiment, setExperiment] = useState<ExperimentRecord | null>(null); const [scorecard, setScorecard] = useState<ExperimentScorecard | null>(null);
  const [streams, setStreams] = useState<Record<string, { text: string; tools: string[] }>>({});
  const client = useRef<ExperimentAcpClient | null>(null); const sessionVariants = useRef(new Map<string, string>());
  const load = useCallback(async () => { setPhase("loading"); setError(""); try {
    let value = await experimentApi.get(experimentId);
    if (!value.annotationWorksheet && value.runs.every((run) => run.status === "completed")) {
      try { await experimentApi.worksheet(experimentId); value = await experimentApi.get(experimentId); }
      catch (cause) { setError(message(cause)); }
    }
    setExperiment(value); if (value.status === "completed" || value.status === "partially_failed") { try { setScorecard(await experimentApi.scorecard(experimentId)); } catch { setScorecard(null); } } setPhase("ready");
  } catch (cause) { setError(message(cause)); setPhase("error"); } }, [experimentId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => client.current?.close(), []);
  function onUpdate(notification: acp.SessionNotification) {
    const variantId = sessionVariants.current.get(notification.sessionId); if (!variantId) return;
    const update = notification.update;
    setStreams((current) => {
      const value = current[variantId] ?? { text: "", tools: [] };
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") return { ...current, [variantId]: { ...value, text: value.text + update.content.text } };
      if (update.sessionUpdate === "tool_call") return { ...current, [variantId]: { ...value, tools: [...value.tools, `${update.name ?? update.title} · ${update.status ?? "pending"}`] } };
      if (update.sessionUpdate === "tool_call_update") return { ...current, [variantId]: { ...value, tools: value.tools.map((item) => item.startsWith(String(update.toolCallId)) ? `${update.toolCallId} · ${update.status}` : item) } };
      return current;
    });
  }
  async function run() {
    if (!experiment || phase === "running") return; setPhase("running"); setError("");
    try {
      client.current ??= await ExperimentAcpClient.open(ACP_URL, onUpdate, () => setError("ACP 连接已断开"));
      const tasks = experiment.runs.map(async (run) => {
        if (run.status === "completed") return;
        try {
          if (run.mode === "reuse_snapshot") { await experimentApi.reuse(experimentId, run.variantId); return; }
          await client.current!.run(experimentId, run.variantId, experiment.promptText, (sessionId) => {
            sessionVariants.current.set(sessionId, run.variantId);
          });
        } catch (cause) { await experimentApi.failRun(experimentId, run.variantId).catch(() => undefined); throw cause; }
      });
      const results = await Promise.allSettled(tasks);
      let problem = results.some((item) => item.status === "rejected") ? "至少一个 lane 运行失败；请重试失败的 lane。" : "";
      if (!problem) {
        try { await experimentApi.worksheet(experimentId); }
        catch (cause) { problem = message(cause); }
      }
      await load(); if (problem) setError(problem);
    } catch (cause) { setError(message(cause)); setPhase("error"); }
  }
  async function cancel() { setError("正在取消运行中的 lane…"); await client.current?.cancelAll(); }
  if (phase === "loading") return <Center title="正在读取实验" detail="从 Remote 读取 ExperimentRecord…" />;
  if (phase === "error" || !experiment) return <Center title="无法打开实验" detail={error || "Experiment 不存在"} retry={() => void load()} />;
  return <ExperimentReady key={experiment.annotationWorksheet?.worksheetId ?? experiment.experimentId} experiment={experiment} scorecard={scorecard} streams={streams} running={phase === "running"} notice={error} onRun={() => void run()} onCancel={() => void cancel()} onReload={() => void load()} onScorecard={setScorecard} />;
}

function ExperimentReady({ experiment, scorecard, streams, running, notice, onRun, onCancel, onReload, onScorecard }: {
  experiment: ExperimentRecord; scorecard: ExperimentScorecard | null; streams: Record<string, { text: string; tools: string[] }>;
  running: boolean; notice: string; onRun: () => void; onCancel: () => void; onReload: () => void; onScorecard: (value: ExperimentScorecard) => void;
}) {
  const [tab, setTab] = useState<Tab>("answers"); const [message, setMessage] = useState("");
  const worksheet = experiment.annotationWorksheet;
  const requirements = worksheet?.requirements ?? [];
  const [understandingMarks, setUnderstandingMarks] = useState<UnderstandingAnnotationFacts["marks"]>(() => scorecard?.annotations.understanding.marks ?? []);
  const [planningMarks, setPlanningMarks] = useState<PlanningAnnotationFacts["marks"]>(() => scorecard?.annotations.planning.marks ?? []);
  const [outputMarks, setOutputMarks] = useState<OutputAnnotationFacts["marks"]>(() => scorecard?.annotations.output.marks ?? []);
  const [completed, setCompleted] = useState(() => ({
    understanding: Boolean(scorecard?.annotations.understanding.completedAt),
    planning: Boolean(scorecard?.annotations.planning.completedAt),
    output: Boolean(scorecard?.annotations.output.completedAt),
  }));
  const answers = useMemo(() => Object.fromEntries(experiment.runs.map((run) => [run.variantId, run.answerTexts.join("\n") || streams[run.variantId]?.text || ""])), [experiment, streams]);
  const terminal = ["completed", "partially_failed", "failed", "cancelled"].includes(experiment.status);
  async function save() { try { await experimentApi.save(experiment.experimentId); setMessage("已保存到“我的对照实验”。"); onReload(); } catch (cause) { setMessage(messageOf(cause)); } }
  async function generateWorksheet(force = false) { try { setMessage(force ? "正在重新调用模型生成标注题目…" : "正在调用模型生成标注题目…"); await experimentApi.worksheet(experiment.experimentId, force); setMessage("标注题目已生成。"); onReload(); } catch (cause) { setMessage(messageOf(cause)); } }
  async function submitAnnotations() { try {
    const now = new Date().toISOString();
    const value = await experimentApi.annotations(experiment.experimentId, {
      understanding: { requirements, marks: understandingMarks, ...(completed.understanding ? { completedAt: now } : {}) },
      planning: { marks: planningMarks, ...(completed.planning ? { completedAt: now } : {}) },
      output: { marks: outputMarks, ...(completed.output ? { completedAt: now } : {}) },
    }); onScorecard(value); setMessage(value.status === "complete" ? "四维评分已生成。" : "注释草稿已保存；三项完成人工标注后才生成总分。"); if (value.status === "complete") setTab("summary");
  } catch (cause) { setMessage(messageOf(cause)); } }
  return <div className="experiment-shell"><header><button aria-label="返回" type="button" onClick={() => history.back()}><ArrowLeft size={17} /></button><div><span>MODEL CONTEXT · COMPARISON</span><h1>{experiment.name}</h1></div><button className="save" disabled={Boolean(experiment.savedAt)} type="button" onClick={() => void save()}>{experiment.savedAt ? <BookmarkCheck size={14} /> : <BookmarkPlus size={14} />}{experiment.savedAt ? "已保存" : "保存本次结果"}</button></header>
    <section className="experiment-task"><div><span>USER TASK</span><strong>{experiment.promptText}</strong></div><em>{experiment.status}</em>{!terminal && (running ? <button className="cancel-run" type="button" onClick={onCancel}>取消运行</button> : <button type="button" onClick={onRun}><Beaker size={14} />运行全部 lane</button>)}</section>
    <nav className="experiment-tabs">{(["answers", "understanding", "planning", "output", "execution", "summary"] as Tab[]).map((item) => <button className={tab === item ? "active" : ""} key={item} type="button" onClick={() => setTab(item)}>{tabLabel(item)}{isAnnotationTab(item) && completed[item] && <Check size={11} />}</button>)}</nav>
    {tab === "answers" && <LaneGrid experiment={experiment}>{(run) => <div className="lane-answer">{run.status === "running" && <span className="lane-live"><Circle size={7} fill="currentColor" />生成中</span>}{(streams[run.variantId]?.tools ?? []).map((item, index) => <small key={`${item}:${index}`}><Wrench size={10} />{item}</small>)}<p>{answers[run.variantId] || (run.status === "pending" ? "等待运行" : run.error?.message ?? "暂无回答")}</p><RunFacts run={run} /></div>}</LaneGrid>}
    {isAnnotationTab(tab) && !worksheet && <WorksheetGate ready={experiment.runs.every((run) => run.status === "completed")} message={message || notice} onGenerate={() => void generateWorksheet()} />}
    {tab === "understanding" && worksheet && <Understanding experiment={experiment} worksheet={worksheet} marks={understandingMarks} setMarks={setUnderstandingMarks} />}
    {tab === "planning" && worksheet && <Planning experiment={experiment} worksheet={worksheet} marks={planningMarks} setMarks={setPlanningMarks} />}
    {tab === "output" && worksheet && <Output experiment={experiment} worksheet={worksheet} marks={outputMarks} setMarks={setOutputMarks} />}
    {tab === "execution" && <Execution experiment={experiment} scorecard={scorecard} />}
    {tab === "summary" && <Summary experiment={experiment} scorecard={scorecard} />}
    {isAnnotationTab(tab) && worksheet && <footer className="annotation-footer"><button className="regenerate" type="button" onClick={() => void generateWorksheet(true)}><RefreshCw size={10} />重新生成题目</button><span>{message || notice || "模型只负责出题；有效性由人工选择，Runtime 由系统计分。"}</span><label><input checked={completed[tab]} type="checkbox" onChange={(event) => setCompleted({ ...completed, [tab]: event.target.checked })} />本维人工标注已完成</label><button type="button" onClick={() => void submitAnnotations()}>保存注释并计算</button></footer>}
    {(message || notice) && (tab === "answers" || tab === "execution" || tab === "summary") && <div className="experiment-message">{message || notice}</div>}
  </div>;
}

function LaneGrid({ experiment, children }: { experiment: ExperimentRecord; children: (run: ExperimentRecord["runs"][number]) => React.ReactNode }) { return <section className={`lane-grid lanes-${experiment.runs.length}`}>{experiment.runs.map((run) => { const variant = experiment.variants.find((item) => item.variantId === run.variantId)!; return <article key={run.variantId}><header><span>{variant.label}</span><div><strong>版本 {variant.label}</strong><small>{variant.mode === "reuse_snapshot" ? "历史快照" : "真实 Runtime"}</small></div><em>{run.status}</em></header>{children(run)}</article>; })}</section>; }

function WorksheetGate({ ready, message, onGenerate }: { ready: boolean; message: string; onGenerate: () => void }) {
  return <section className="worksheet-gate"><Beaker size={20} /><h2>{ready ? "生成本次实验的人工标注题目" : "先完成全部 lane"}</h2><p>{ready ? "模型会合并需求、提取工作流，并把每条结果切成稳定分段；它不判断好坏、不自动打分。" : "所有真实回答和工具过程齐全后，才能为本次实验生成题目。"}</p>{message && <small>{message}</small>}<button disabled={!ready} type="button" onClick={onGenerate}>调用模型生成题目</button></section>;
}

function Understanding({ experiment, worksheet, marks, setMarks }: { experiment: ExperimentRecord; worksheet: ExperimentAnnotationWorksheet; marks: UnderstandingAnnotationFacts["marks"]; setMarks: React.Dispatch<React.SetStateAction<UnderstandingAnnotationFacts["marks"]>> }) {
  function mark(variantId: string, requirementId: string, verdict: "met" | "missed") { setMarks((current) => [...current.filter((item) => !(item.variantId === variantId && item.requirementId === requirementId)), { variantId, requirementId, verdict }]); }
  return <section className="annotation-panel"><header><Check size={16} /><div><strong>需求理解人工量表</strong><small>模型已合并去重公共需求；请逐 lane 判断命中/未命中</small></div><em>{worksheet.requirements.length} 题</em></header><div className="generated-questions">{worksheet.requirements.map((item, index) => <div key={item.requirementId}><b>{index + 1}</b><span>{item.label}</span><small>权重 {item.weight}</small></div>)}</div><LaneGrid experiment={experiment}>{(run) => <div className="fact-list">{worksheet.requirements.map((requirement) => { const verdict = marks.find((item) => item.variantId === run.variantId && item.requirementId === requirement.requirementId)?.verdict; return <div key={requirement.requirementId}><span>{requirement.label}</span><button className={verdict === "met" ? "effective active" : ""} type="button" onClick={() => mark(run.variantId, requirement.requirementId, "met")}>命中</button><button className={verdict === "missed" ? "none active" : ""} type="button" onClick={() => mark(run.variantId, requirement.requirementId, "missed")}>未命中</button></div>; })}</div>}</LaneGrid></section>;
}

function Planning({ experiment, worksheet, marks, setMarks }: { experiment: ExperimentRecord; worksheet: ExperimentAnnotationWorksheet; marks: PlanningAnnotationFacts["marks"]; setMarks: React.Dispatch<React.SetStateAction<PlanningAnnotationFacts["marks"]>> }) {
  function verdict(variantId: string, stepId: string, value: AnnotationVerdict) { setMarks((current) => [...current.filter((item) => !(item.variantId === variantId && item.stepId === stepId)), { variantId, stepId, verdict: value }]); }
  return <section className="annotation-panel"><header><Route size={16} /><div><strong>Workflow 规划人工量表</strong><small>模型已按回答和工具过程提取步骤；请人工判断有效性</small></div></header><LaneGrid experiment={experiment}>{(run) => <div className="planning-editor">{(worksheet.workflows.find((item) => item.variantId === run.variantId)?.steps ?? []).map((step, index) => { const mark = marks.find((item) => item.variantId === run.variantId && item.stepId === step.stepId); return <div className="planning-step" key={step.stepId}><b>{index + 1}</b><span>{step.label}</span><SemanticButtons value={mark?.verdict} onChange={(value) => verdict(run.variantId, step.stepId, value)} /></div>; })}</div>}</LaneGrid></section>;
}

function Output({ experiment, worksheet, marks, setMarks }: { experiment: ExperimentRecord; worksheet: ExperimentAnnotationWorksheet; marks: OutputAnnotationFacts["marks"]; setMarks: React.Dispatch<React.SetStateAction<OutputAnnotationFacts["marks"]>> }) {
  function verdict(variantId: string, section: ExperimentAnnotationWorksheet["outputSections"][number]["sections"][number], value: AnnotationVerdict) { setMarks((current) => [...current.filter((item) => !(item.variantId === variantId && item.answerSectionId === section.answerSectionId)), { variantId, answerSectionId: section.answerSectionId, start: section.start, end: section.end, verdict: value, quotedTextHash: section.quotedTextHash }]); }
  return <section className="annotation-panel"><header><Highlighter size={16} /><div><strong>最终有效输出人工标注</strong><small>模型已将真实回答完整分段；请逐段标记有效性</small></div></header><LaneGrid experiment={experiment}>{(run) => <div className="output-editor">{(worksheet.outputSections.find((item) => item.variantId === run.variantId)?.sections ?? []).map((section, index) => { const mark = marks.find((item) => item.variantId === run.variantId && item.answerSectionId === section.answerSectionId); return <article key={section.answerSectionId}><header><b>{index + 1}</b><strong>{section.label}</strong><small>{section.start}–{section.end}</small></header><p>{section.preview}</p><SemanticButtons value={mark?.verdict} onChange={(value) => verdict(run.variantId, section, value)} /></article>; })}</div>}</LaneGrid></section>;
}

function SemanticButtons({ value, onChange }: { value: AnnotationVerdict | undefined; onChange: (value: AnnotationVerdict) => void }) { return <span className="semantic-buttons"><button className={value === "effective" ? "effective active" : ""} type="button" onClick={() => onChange("effective")}>有效</button><button className={value === "partial" ? "partial active" : ""} type="button" onClick={() => onChange("partial")}>部分有效</button><button className={value === "none" ? "none active" : ""} type="button" onClick={() => onChange("none")}>不计分</button></span>; }

function Execution({ experiment, scorecard }: { experiment: ExperimentRecord; scorecard: ExperimentScorecard | null }) { return <section className="annotation-panel"><header><ShieldCheck size={16} /><div><strong>Runtime 执行能力</strong><small>系统从真实运行指标按 runtime_execution_v1 计算，不调用自动评分模型</small></div></header><LaneGrid experiment={experiment}>{(run) => { const score = scorecard?.variants.find((item) => item.variantId === run.variantId); const m = run.executionMetrics; return <div className="execution-facts"><strong>{score ? `${score.dimensionScores.execution} 分` : "待生成评分卡"}</strong><span>完成：{m?.normallyCompleted ? "是" : "否"}</span><span>耗时：{m?.totalDurationMs ?? "—"} ms</span><span>Model Rounds：{m?.modelRoundCount ?? "—"}</span><span>Tool 成功 / 失败：{m ? `${m.toolSuccessCount} / ${m.toolFailureCount}` : "—"}</span><span>权限违规：{m?.permissionViolationCount ?? "—"}</span><span>重复 Tool：{m?.hasRepeatedToolCall ? "有" : "无"}</span></div>; }}</LaneGrid></section>; }

function RunFacts({ run }: { run: ExperimentRecord["runs"][number] }) { const facts = run.runtimeFacts; if (!facts) return null; return <details className="run-facts"><summary><Braces size={11} />本 lane 的真实运行输入</summary><div>{facts.agentSnapshotHash && <span>Agent snapshot <code>{facts.agentSnapshotHash.slice(0, 12)}</code></span>}<span>{facts.capabilityGenerations} 个能力 generation · {facts.capabilityToolNames.length} tools</span><span>{facts.contextSources.length} 个 context sources{facts.contextSources.some((item) => item.truncated) ? " · 有截断" : ""}</span>{facts.providerInputBytes !== undefined && <span>Provider input {facts.providerInputBytes} bytes · hash <code>{facts.providerInputHash?.slice(0, 12)}</code></span>}{facts.usage && <span>Usage input {facts.usage.inputTokens ?? "—"} / output {facts.usage.outputTokens ?? "—"}</span>}{facts.stopReason && <span>Stop reason {facts.stopReason}</span>}</div></details>; }

function Summary({ experiment, scorecard }: { experiment: ExperimentRecord; scorecard: ExperimentScorecard | null }) { if (!scorecard || scorecard.status !== "complete") return <Center title="评分卡尚未完成" detail="完成理解、规划、输出三项人工标注后，才生成四维总分、雷达图、排名与 winner。" />; return <section className="summary-grid"><div className="radar-card"><header><BarChart3 size={16} /><div><strong>四维雷达图</strong><small>理解、规划、输出、执行各占 25%</small></div></header><Radar scorecard={scorecard} experiment={experiment} /></div><div className="score-ledger"><header><strong>排名</strong><small>{scorecard.winnerVariantIds?.length && scorecard.winnerVariantIds.length > 1 ? "并列 winner" : "winner"}</small></header>{scorecard.ranking?.map((row) => <article key={`${row.rank}:${row.totalScore}`}><b>#{row.rank}</b><span>{row.variantIds.map((id) => experiment.variants.find((item) => item.variantId === id)?.label ?? id).join(" / ")}</span><strong>{row.totalScore}</strong></article>)}</div></section>; }

function Radar({ scorecard, experiment }: { scorecard: ExperimentScorecard; experiment: ExperimentRecord }) { const center = 120; const radius = 86; const axes = ["understanding", "planning", "output", "execution"] as const; const labels = ["理解", "规划", "输出", "执行"]; function point(index: number, value: number) { const angle = -Math.PI / 2 + index * Math.PI / 2; return `${center + Math.cos(angle) * radius * value / 100},${center + Math.sin(angle) * radius * value / 100}`; } return <svg aria-label="四维评分雷达图" viewBox="0 0 240 240">{[.25,.5,.75,1].map((scale) => <polygon className="radar-grid" key={scale} points={axes.map((_, i) => point(i, scale * 100)).join(" ")} />)}{scorecard.variants.map((variant, index) => <polygon className={`radar-series series-${index}`} key={variant.variantId} points={axes.map((axis, i) => point(i, variant.dimensionScores[axis] ?? 0)).join(" ")} />)}{labels.map((label, index) => { const [x,y] = point(index, 118).split(","); return <text key={label} x={x} y={y}>{label}</text>; })}<g className="radar-legend">{scorecard.variants.map((variant, index) => <text key={variant.variantId} x="12" y={212 + index * 12}>{experiment.variants.find((item) => item.variantId === variant.variantId)?.label} · {variant.totalScore}</text>)}</g></svg>; }

function Center({ title, detail, retry }: { title: string; detail: string; retry?: () => void }) { return <main className="centered-state"><div><Beaker size={20} /><h1>{title}</h1><p>{detail}</p>{retry && <button type="button" onClick={retry}>重试</button>}</div></main>; }
function isAnnotationTab(tab: Tab): tab is AnnotationTab { return tab === "understanding" || tab === "planning" || tab === "output"; }
function tabLabel(tab: Tab) { return ({ answers: "回答对比", understanding: "需求理解", planning: "Workflow 规划", output: "有效输出", execution: "执行能力", summary: "四维汇总" })[tab]; }
function message(value: unknown) { return value instanceof Error ? value.message : String(value); } function messageOf(value: unknown) { return message(value); }
