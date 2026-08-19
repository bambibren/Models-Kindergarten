import { ArrowLeft, BarChart3, Beaker, BookmarkCheck, BookmarkPlus, Braces, Check, Circle, Highlighter, RefreshCw, ShieldCheck, Wrench } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type * as acp from "@agentclientprotocol/sdk";
import type {
  AnnotationVerdict,
  AnyExperimentRecord,
  ExecutionMetricsSnapshot,
  ExperimentAnnotationWorksheet,
  ExperimentRunRuntimeFacts,
  ExperimentScorecard,
  ModelStudentSummary,
  OutputAnnotationFacts,
  PlanningAnnotationFacts,
  UnderstandingAnnotationFacts,
} from "@kindergarten/contracts";
import { experimentApi } from "../experiment-api.js";
import { ExperimentAcpClient, type ElicitationIntervention, type ExperimentIntervention } from "../experiment-acp-client.js";
import "./experiment-evaluation.css";

const ACP_URL = import.meta.env.VITE_ACP_URL ?? "ws://127.0.0.1:7331/acp";
type Phase = "loading" | "ready" | "running" | "error";
type Tab = "answers" | "understanding" | "planning" | "output" | "execution" | "summary";
type AnnotationTab = "understanding" | "planning" | "output";

interface EvalRun {
  variantId: string;
  status: string;
  answerTexts: string[];
  executionMetrics?: ExecutionMetricsSnapshot;
  runtimeFacts?: ExperimentRunRuntimeFacts;
  error?: { message: string };
  hadHumanIntervention?: boolean;
}
interface EvalVariant {
  variantId: string;
  label: "A" | "B" | "C";
  subtitle: string;
  model?: { display: string; provider: string };
  reasoning?: { requested: string; resolved: string; native: string };
}
interface EvalExperiment {
  experimentId: string;
  name: string;
  promptText: string;
  status: string;
  savedAt?: string;
  legacy: boolean;
  variants: EvalVariant[];
  runs: EvalRun[];
  annotationWorksheet?: ExperimentAnnotationWorksheet;
  worksheetModelStudentId?: string;
}

export function ExperimentEvaluationPage({ experimentId }: { experimentId: string }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState("");
  const [experiment, setExperiment] = useState<EvalExperiment | null>(null);
  const [scorecard, setScorecard] = useState<ExperimentScorecard | null>(null);
  const [streams, setStreams] = useState<Record<string, { text: string; tools: string[] }>>({});
  const [interventions, setInterventions] = useState<Record<string, ExperimentIntervention[]>>({});
  const [models, setModels] = useState<ModelStudentSummary[]>([]);
  const client = useRef<ExperimentAcpClient | null>(null);
  const sessionVariants = useRef(new Map<string, string>());

  const load = useCallback(async () => {
    setPhase("loading"); setError("");
    try {
      const [initial, catalog] = await Promise.all([
        experimentApi.get(experimentId),
        experimentApi.models().catch(() => ({ items: [] })),
      ]);
      setModels(catalog.items.filter((item) => item.status === "ready"));
      const raw = initial;
      const value = normalizeExperiment(raw);
      setExperiment(value);
      if (terminalStatus(value.status)) {
        try { setScorecard(await experimentApi.scorecard(experimentId)); } catch { setScorecard(null); }
      }
      setPhase("ready");
    } catch (cause) { setError(message(cause)); setPhase("error"); }
  }, [experimentId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => client.current?.close(), []);

  function onUpdate(notification: acp.SessionNotification) {
    const variantId = sessionVariants.current.get(notification.sessionId); if (!variantId) return;
    const update = notification.update;
    setStreams((current) => {
      const value = current[variantId] ?? { text: "", tools: [] };
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") return { ...current, [variantId]: { ...value, text: value.text + update.content.text } };
      if (update.sessionUpdate === "tool_call") return { ...current, [variantId]: { ...value, tools: [...value.tools, toolStreamEntry(update.toolCallId, update.name ?? update.title, update.status ?? "pending")] } };
      if (update.sessionUpdate === "tool_call_update") return { ...current, [variantId]: { ...value, tools: value.tools.map((item) => updateToolStreamEntry(item, update.toolCallId, update.status ?? "pending")) } };
      return current;
    });
  }

  function enqueueIntervention(testId: string, intervention: ExperimentIntervention) {
    setInterventions((current) => ({ ...current, [testId]: [...(current[testId] ?? []), intervention] }));
  }

  async function finishIntervention(testId: string, interventionId: string, content?: string | Record<string, unknown>) {
    const intervention = interventions[testId]?.find((item) => item.interventionId === interventionId);
    if (!intervention) return;
    if (intervention.kind === "permission") await intervention.respond(typeof content === "string" ? content : undefined);
    else await intervention.respond(typeof content === "object" ? content : undefined);
    setInterventions((current) => ({ ...current, [testId]: (current[testId] ?? []).filter((item) => item.interventionId !== interventionId) }));
  }

  async function run() {
    if (!experiment || experiment.legacy || experiment.status !== "prepared" || phase === "running") return;
    setPhase("running"); setError("");
    try {
      client.current ??= await ExperimentAcpClient.open(
        ACP_URL,
        onUpdate,
        enqueueIntervention,
        (id, testId, fact) => experimentApi.intervention(id, testId, fact).then(() => undefined),
        () => setError("ACP 连接已断开"),
      );
      const results = await Promise.allSettled(experiment.runs.map(async (run) => {
        try {
          await client.current!.run(experimentId, run.variantId, experiment.promptText, (sessionId) => sessionVariants.current.set(sessionId, run.variantId));
        } catch (cause) {
          await experimentApi.failRun(experimentId, run.variantId).catch(() => undefined);
          throw cause;
        }
      }));
      const problem = results.some((item) => item.status === "rejected") ? "至少一个 Test 运行失败；本次实验已终止，不能重跑。" : "";
      await load(); if (problem) setError(problem);
    } catch (cause) { setError(message(cause)); setPhase("error"); }
  }

  async function cancel() {
    setError("正在取消运行中的 Test…");
    await Promise.all([client.current?.cancelAll(), experimentApi.cancel(experimentId)]);
    await load();
  }

  if (phase === "loading") return <Center title="正在读取实验" detail="从 Remote 读取 ExperimentRecord…" />;
  if (phase === "error" || !experiment) return <Center title="无法打开实验" detail={error || "Experiment 不存在"} retry={() => void load()} />;
  return <ExperimentReady key={experiment.annotationWorksheet?.worksheetId ?? experiment.experimentId}
    experiment={experiment} scorecard={scorecard} streams={streams} interventions={interventions} models={models}
    running={phase === "running"} notice={error} onRun={() => void run()} onCancel={() => void cancel()}
    onIntervention={finishIntervention} onReload={() => void load()} onScorecard={setScorecard} />;
}

function ExperimentReady({ experiment, scorecard, streams, interventions, models, running, notice, onRun, onCancel, onIntervention, onReload, onScorecard }: {
  experiment: EvalExperiment;
  scorecard: ExperimentScorecard | null;
  streams: Record<string, { text: string; tools: string[] }>;
  interventions: Record<string, ExperimentIntervention[]>;
  models: ModelStudentSummary[];
  running: boolean;
  notice: string;
  onRun: () => void;
  onCancel: () => void;
  onIntervention: (testId: string, interventionId: string, content?: string | Record<string, unknown>) => void | Promise<void>;
  onReload: () => void;
  onScorecard: (value: ExperimentScorecard) => void;
}) {
  const [tab, setTab] = useState<Tab>("answers"); const [messageText, setMessageText] = useState("");
  const [worksheetModelStudentId, setWorksheetModelStudentId] = useState(experiment.worksheetModelStudentId ?? models[0]?.modelStudentId ?? "");
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const worksheet = experiment.annotationWorksheet;
  const requirements = worksheet?.requirements ?? [];
  const [understandingMarks, setUnderstandingMarks] = useState<UnderstandingAnnotationFacts["marks"]>(() => scorecard?.annotations.understanding.marks ?? []);
  const [planningMarks, setPlanningMarks] = useState<PlanningAnnotationFacts["marks"]>(() => scorecard?.annotations.planning.marks ?? []);
  const [outputMarks, setOutputMarks] = useState<OutputAnnotationFacts["marks"]>(() => scorecard?.annotations.output.marks ?? []);
  const [completed, setCompleted] = useState(() => ({ understanding: Boolean(scorecard?.annotations.understanding.completedAt), planning: Boolean(scorecard?.annotations.planning.completedAt), output: Boolean(scorecard?.annotations.output.completedAt) }));
  const answers = useMemo(() => Object.fromEntries(experiment.runs.map((run) => [run.variantId, run.answerTexts.join("\n") || streams[run.variantId]?.text || ""])), [experiment, streams]);
  const terminal = terminalStatus(experiment.status);
  async function save() { try { await experimentApi.save(experiment.experimentId); setMessageText("已保存到“我的对照实验”。"); onReload(); } catch (cause) { setMessageText(message(cause)); } }
  async function generateWorksheet(force = false) { if (experiment.legacy) return; try { setMessageText(force ? "正在重新调用评测辅助模型…" : "正在调用评测辅助模型…"); await experimentApi.worksheet(experiment.experimentId, force, worksheetModelStudentId); setConfirmRegenerate(false); setMessageText("标注题目已生成。"); onReload(); } catch (cause) { setMessageText(message(cause)); } }
  async function submitAnnotations() { if (experiment.legacy) return; try {
    const now = new Date().toISOString();
    const value = await experimentApi.annotations(experiment.experimentId, {
      understanding: { requirements, marks: understandingMarks, ...(completed.understanding ? { completedAt: now } : {}) },
      planning: { marks: planningMarks, ...(completed.planning ? { completedAt: now } : {}) },
      output: { marks: outputMarks, ...(completed.output ? { completedAt: now } : {}) },
    }); onScorecard(value); setMessageText(value.status === "complete" ? "四维评分已生成。" : "注释草稿已保存；证据完整后才生成总分。"); if (value.status === "complete") setTab("summary");
  } catch (cause) { setMessageText(message(cause)); } }
  return <div className="experiment-shell"><header><button aria-label="返回" type="button" onClick={() => history.back()}><ArrowLeft size={17} /></button><div><span>MODEL CONTEXT · COMPARISON</span><h1>{experiment.name}</h1></div>{!experiment.legacy && <button className="save" disabled={Boolean(experiment.savedAt)} type="button" onClick={() => void save()}>{experiment.savedAt ? <BookmarkCheck size={14} /> : <BookmarkPlus size={14} />}{experiment.savedAt ? "已保存" : "保存本次结果"}</button>}</header>
    <section className="experiment-task"><div><span>USER TASK · {experiment.legacy ? "旧版实验语义" : "V2 单轮"}</span><strong>{experiment.promptText}</strong></div><em>{experiment.status}</em>{!experiment.legacy && experiment.status === "prepared" && !running && <button type="button" onClick={onRun}><Beaker size={14} />运行全部 Test</button>}{running && <button className="cancel-run" type="button" onClick={onCancel}>取消运行</button>}</section>
    {experiment.legacy && <div className="experiment-message">旧实验只读保留；不提供重跑、转换、克隆或重置。</div>}
    <nav className="experiment-tabs">{(["answers", "understanding", "planning", "output", "execution", "summary"] as Tab[]).map((item) => <button className={tab === item ? "active" : ""} key={item} type="button" onClick={() => setTab(item)}>{tabLabel(item)}{isAnnotationTab(item) && completed[item] && <Check size={11} />}</button>)}</nav>
    {tab === "answers" && <LaneGrid experiment={experiment} scorecard={scorecard} interventions={interventions} onIntervention={onIntervention} showRuntimeHeader>{(run) => <div className="lane-answer">{run.status === "running" && <span className="lane-live"><Circle size={7} fill="currentColor" />生成中</span>}{(streams[run.variantId]?.tools ?? []).map((item, index) => <small key={`${item}:${index}`}><Wrench size={10} />{toolStreamLabel(item)}</small>)}<p>{answers[run.variantId] || (run.status === "pending" ? "等待运行" : run.error?.message ?? "暂无回答")}</p><RunFacts run={run} /></div>}</LaneGrid>}
    {isAnnotationTab(tab) && !worksheet && (experiment.legacy ? <Center title="旧实验没有标注工作表" detail="旧记录保持原样，不会为其补跑或补生成工作表。" /> : <WorksheetGate ready={experiment.runs.every((run) => run.status === "completed")} message={messageText || notice} models={models} modelStudentId={worksheetModelStudentId} onModelChange={setWorksheetModelStudentId} onGenerate={() => void generateWorksheet()} />)}
    {tab === "understanding" && worksheet && <Understanding experiment={experiment} worksheet={worksheet} marks={understandingMarks} setMarks={setUnderstandingMarks} />}
    {tab === "planning" && worksheet && <Planning experiment={experiment} worksheet={worksheet} marks={planningMarks} setMarks={setPlanningMarks} />}
    {tab === "output" && worksheet && <Output experiment={experiment} worksheet={worksheet} marks={outputMarks} setMarks={setOutputMarks} />}
    {tab === "execution" && <Execution experiment={experiment} scorecard={scorecard} />}
    {tab === "summary" && <Summary experiment={experiment} scorecard={scorecard} />}
    {isAnnotationTab(tab) && worksheet && !experiment.legacy && <footer className="annotation-footer"><label className="worksheet-model-select"><span>标注题目整理模型</span><select value={worksheetModelStudentId} onChange={(event) => { setWorksheetModelStudentId(event.target.value); setConfirmRegenerate(false); }}>{models.map((item) => <option key={item.modelStudentId} value={item.modelStudentId}>{item.displayName}</option>)}</select></label><button className="regenerate" disabled={!worksheetModelStudentId} type="button" onClick={() => { if (confirmRegenerate) void generateWorksheet(true); else { setConfirmRegenerate(true); setMessageText("重新生成会清除旧工作表及其注释/评分；回答与运行事实保持不变。请再次确认。"); } }}><RefreshCw size={10} />{confirmRegenerate ? "确认重新生成" : "重新生成题目"}</button>{confirmRegenerate && <button className="regenerate" type="button" onClick={() => { setConfirmRegenerate(false); setMessageText(""); }}>取消</button>}<span>{messageText || notice || "模型只负责出题；有效性由人工选择，Runtime 由系统计分。"}</span><label><input checked={completed[tab]} type="checkbox" onChange={(event) => setCompleted({ ...completed, [tab]: event.target.checked })} />本维人工标注已完成</label><button type="button" onClick={() => void submitAnnotations()}>保存注释并计算</button></footer>}
    {(messageText || notice) && (tab === "answers" || tab === "execution" || tab === "summary") && <div className="experiment-message">{messageText || notice}</div>}
  </div>;
}

function LaneGrid({ experiment, scorecard, interventions = {}, onIntervention, showRuntimeHeader = false, children }: {
  experiment: EvalExperiment;
  scorecard?: ExperimentScorecard | null;
  interventions?: Record<string, ExperimentIntervention[]>;
  onIntervention?: (testId: string, interventionId: string, content?: string | Record<string, unknown>) => void | Promise<void>;
  showRuntimeHeader?: boolean;
  children: (run: EvalRun) => React.ReactNode;
}) { return <section className={`lane-grid lanes-${experiment.runs.length}`}>{experiment.runs.map((run) => { const variant = experiment.variants.find((item) => item.variantId === run.variantId)!; const score = scorecard?.variants.find((item) => item.variantId === run.variantId); const intervention = interventions[run.variantId]?.[0]; return <article key={run.variantId}><header><span>{variant.label}</span><div><strong>Test {variant.label}</strong><small>{variant.subtitle}</small></div><em>{run.status}</em></header>{showRuntimeHeader && <>{intervention && onIntervention && <LaneIntervention testId={run.variantId} intervention={intervention} onRespond={onIntervention} />}<LaneModelFacts variant={variant} /><div className="lane-score-strip"><span>理解 {score?.dimensionScores.understanding ?? "—"}</span><span>规划 {score?.dimensionScores.planning ?? "—"}</span><span>输出 {score?.dimensionScores.output ?? "—"}</span><span>执行 {score?.dimensionScores.execution ?? "—"}</span></div></>}{children(run)}</article>; })}</section>; }

function LaneIntervention({ testId, intervention, onRespond }: { testId: string; intervention?: ExperimentIntervention; onRespond?: (testId: string, interventionId: string, content?: string | Record<string, unknown>) => void | Promise<void> }) {
  const [form, setForm] = useState<Record<string, unknown>>({});
  useEffect(() => setForm({}), [intervention?.interventionId]);
  if (!intervention || !onRespond) return null;
  if (intervention.kind === "permission") return <section className="lane-intervention"><header><strong>需要授权 · {intervention.title}</strong><small>只影响当前 Test；选择会记录到运行事实。</small></header>{intervention.detail && <pre>{intervention.detail}</pre>}<footer>{intervention.options.map((option) => <button key={option.optionId} type="button" onClick={() => onRespond(testId, intervention.interventionId, option.optionId)}>{option.name}</button>)}<button className="cancel" type="button" onClick={() => onRespond(testId, intervention.interventionId)}>取消</button></footer></section>;
  return <section className="lane-intervention"><header><strong>{intervention.title}</strong><small>{intervention.message}</small></header><div className="lane-elicitation-fields">{intervention.fields.map((field) => <label key={field.name}><span>{field.label}{field.required ? " *" : ""}</span>{field.enumValues ? <select value={String(form[field.name] ?? "")} onChange={(event) => setForm({ ...form, [field.name]: event.target.value })}><option value="">请选择</option>{field.enumValues.map((value) => <option key={String(value)} value={String(value)}>{String(value)}</option>)}</select> : field.type === "boolean" ? <input checked={form[field.name] === true} type="checkbox" onChange={(event) => setForm({ ...form, [field.name]: event.target.checked })} /> : <input type={field.type === "number" ? "number" : "text"} value={String(form[field.name] ?? "")} onChange={(event) => setForm({ ...form, [field.name]: field.type === "number" ? Number(event.target.value) : event.target.value })} />}{field.description && <small>{field.description}</small>}</label>)}</div><footer><button disabled={!elicitationComplete(intervention, form)} type="button" onClick={() => onRespond(testId, intervention.interventionId, form)}>提交回答</button><button className="cancel" type="button" onClick={() => onRespond(testId, intervention.interventionId)}>取消</button></footer></section>;
}

function LaneModelFacts({ variant }: { variant: EvalVariant }) { return <section className="lane-model-facts"><header><strong>模型与推理（已冻结）</strong><small>来自 prepare-run Test 快照</small></header>{variant.model ? <><span><b>{variant.model.display}</b><small>{variant.model.provider}</small></span><span><b>{variant.reasoning?.requested} → {variant.reasoning?.resolved}</b><small>{variant.reasoning?.native}</small></span></> : <p>旧记录只保存实验级模型，按原始语义展示。</p>}</section>; }

function WorksheetGate({ ready, message, models, modelStudentId, onModelChange, onGenerate }: { ready: boolean; message: string; models: ModelStudentSummary[]; modelStudentId: string; onModelChange: (value: string) => void; onGenerate: () => void }) { return <section className="worksheet-gate"><Braces size={20} /><h2>生成三维人工标注题目</h2><p>评测辅助模型只整理公共需求、工作流和回答原文分段，不给 verdict 或分数。</p><label><span>标注题目整理模型</span><select value={modelStudentId} onChange={(event) => onModelChange(event.target.value)}>{models.map((item) => <option key={item.modelStudentId} value={item.modelStudentId}>{item.displayName}</option>)}</select></label>{message && <small>{message}</small>}<button disabled={!ready || !modelStudentId} type="button" onClick={onGenerate}>生成标注题目</button></section>; }

function Understanding({ experiment, worksheet, marks, setMarks }: { experiment: EvalExperiment; worksheet: ExperimentAnnotationWorksheet; marks: UnderstandingAnnotationFacts["marks"]; setMarks: React.Dispatch<React.SetStateAction<UnderstandingAnnotationFacts["marks"]>> }) { function verdict(variantId: string, requirementId: string, value: "met" | "missed") { setMarks((current) => [...current.filter((item) => !(item.variantId === variantId && item.requirementId === requirementId)), { variantId, requirementId, verdict: value }]); } return <section className="annotation-panel"><header><Check size={16} /><div><strong>需求理解人工标注</strong><small>逐条判断各 Test 是否理解公共需求 · {worksheetGeneratorLabel(worksheet)}</small></div></header><div className="generated-questions">{worksheet.requirements.map((item, index) => <div key={item.requirementId}><b>{index + 1}</b><span>{item.label}</span><small>权重 {item.weight}</small></div>)}</div><LaneGrid experiment={experiment}>{(run) => <div className="fact-list">{worksheet.requirements.map((item) => { const mark = marks.find((candidate) => candidate.variantId === run.variantId && candidate.requirementId === item.requirementId); return <div key={item.requirementId}><span>{item.label}</span><button className={mark?.verdict === "met" ? "effective active" : ""} type="button" onClick={() => verdict(run.variantId, item.requirementId, "met")}>理解</button><button className={mark?.verdict === "missed" ? "none active" : ""} type="button" onClick={() => verdict(run.variantId, item.requirementId, "missed")}>遗漏</button></div>; })}</div>}</LaneGrid></section>; }
function Planning({ experiment, worksheet, marks, setMarks }: { experiment: EvalExperiment; worksheet: ExperimentAnnotationWorksheet; marks: PlanningAnnotationFacts["marks"]; setMarks: React.Dispatch<React.SetStateAction<PlanningAnnotationFacts["marks"]>> }) { function verdict(variantId: string, stepId: string, value: AnnotationVerdict) { setMarks((current) => [...current.filter((item) => !(item.variantId === variantId && item.stepId === stepId)), { variantId, stepId, verdict: value }]); } return <section className="annotation-panel"><header><Braces size={16} /><div><strong>Workflow 规划人工标注</strong><small>按实际回答与 Tool 事件整理出的步骤逐项判断 · {worksheetGeneratorLabel(worksheet)}</small></div></header><LaneGrid experiment={experiment}>{(run) => <div className="planning-editor">{(worksheet.workflows.find((item) => item.variantId === run.variantId)?.steps ?? []).map((step, index) => { const mark = marks.find((item) => item.variantId === run.variantId && item.stepId === step.stepId); return <div className="planning-step" key={step.stepId}><b>{index + 1}</b><span>{step.label}</span><SemanticButtons value={mark?.verdict} onChange={(value) => verdict(run.variantId, step.stepId, value)} /></div>; })}</div>}</LaneGrid></section>; }
function Output({ experiment, worksheet, marks, setMarks }: { experiment: EvalExperiment; worksheet: ExperimentAnnotationWorksheet; marks: OutputAnnotationFacts["marks"]; setMarks: React.Dispatch<React.SetStateAction<OutputAnnotationFacts["marks"]>> }) { function verdict(variantId: string, section: ExperimentAnnotationWorksheet["outputSections"][number]["sections"][number], value: AnnotationVerdict) { setMarks((current) => [...current.filter((item) => !(item.variantId === variantId && item.answerSectionId === section.answerSectionId)), { variantId, answerSectionId: section.answerSectionId, start: section.start, end: section.end, verdict: value, quotedTextHash: section.quotedTextHash }]); } return <section className="annotation-panel"><header><Highlighter size={16} /><div><strong>最终有效输出人工标注</strong><small>模型已将真实回答完整分段；请逐段标记有效性 · {worksheetGeneratorLabel(worksheet)}</small></div></header><LaneGrid experiment={experiment}>{(run) => <div className="output-editor">{(worksheet.outputSections.find((item) => item.variantId === run.variantId)?.sections ?? []).map((section, index) => { const mark = marks.find((item) => item.variantId === run.variantId && item.answerSectionId === section.answerSectionId); return <article key={section.answerSectionId}><header><b>{index + 1}</b><strong>{section.label}</strong><small>{section.start}–{section.end}</small></header><p>{section.preview}</p><SemanticButtons value={mark?.verdict} onChange={(value) => verdict(run.variantId, section, value)} /></article>; })}</div>}</LaneGrid></section>; }
function SemanticButtons({ value, onChange }: { value: AnnotationVerdict | undefined; onChange: (value: AnnotationVerdict) => void }) { return <span className="semantic-buttons"><button className={value === "effective" ? "effective active" : ""} type="button" onClick={() => onChange("effective")}>有效</button><button className={value === "partial" ? "partial active" : ""} type="button" onClick={() => onChange("partial")}>部分有效</button><button className={value === "none" ? "none active" : ""} type="button" onClick={() => onChange("none")}>不计分</button></span>; }
function Execution({ experiment, scorecard }: { experiment: EvalExperiment; scorecard: ExperimentScorecard | null }) { return <section className="annotation-panel"><header><ShieldCheck size={16} /><div><strong>Runtime 执行能力</strong><small>context_experiment_four_dimensions v1 · runtime_execution_v1；缺失指标显示不可用，不以 0 代替</small></div></header><LaneGrid experiment={experiment}>{(run) => { const score = scorecard?.variants.find((item) => item.variantId === run.variantId); const m = run.executionMetrics; const components = score?.executionEvidence.componentScores; return <div className="execution-facts"><strong>{score ? `${score.dimensionScores.execution} 分` : m ? "待完成人工标注后生成评分卡" : "执行指标不可用"}</strong><span>正常完成：{m ? m.normallyCompleted ? "是" : "否" : "不可用"}</span><span>首 Token：{m?.firstTokenLatencyMs !== undefined ? `${m.firstTokenLatencyMs} ms` : "不可用"}</span><span>模型执行总耗时：{m ? `${m.totalDurationMs} ms` : "不可用"}（本次观测值）</span><span>基础设施排队：不可用（当前 Runtime 未单独采集）</span><span>Model Rounds：{m?.modelRoundCount ?? "不可用"}</span><span>Tool 成功 / 失败：{m ? `${m.toolSuccessCount} / ${m.toolFailureCount}` : "不可用"}</span><span>权限违规：{m?.permissionViolationCount ?? "不可用"}</span><span>重复 Tool：{m ? m.hasRepeatedToolCall ? "有" : "无" : "不可用"}</span>{components && <details><summary>执行分组件</summary><span>完成 {components.completion} · Tool 可靠性 {components.toolReliability} · 错误卫生 {components.errorHygiene} · 权限安全 {components.permissionSafety} · 无重复调用 {components.noRepeatedCalls} · 响应 {components.responsiveness}</span></details>}</div>; }}</LaneGrid></section>; }
function RunFacts({ run }: { run: EvalRun }) {
  const facts = run.runtimeFacts;
  if (!facts) return null;
  return <details className="run-facts"><summary><Braces size={11} />本 Test 的真实运行上下文</summary><div className="run-facts-summary">{facts.agentSnapshotHash && <span>Agent snapshot <code>{facts.agentSnapshotHash.slice(0, 12)}</code></span>}<span>{facts.capabilityGenerations} 个能力 generation · {facts.capabilityToolNames.length} tools</span><span>{facts.modelRounds?.length ?? 0} 个真实模型轮次</span>{facts.usage && <span>Usage input {facts.usage.inputTokens ?? "—"} / output {facts.usage.outputTokens ?? "—"}</span>}{facts.stopReason && <span>Stop reason {facts.stopReason}</span>}{run.hadHumanIntervention && <span>含人工介入</span>}</div>{facts.modelRounds?.map((round) => <details className="model-round-facts" key={round.roundIndex}><summary>模型轮次 {round.roundIndex + 1} · capability generation {round.capabilityGeneration}</summary><div className="model-round-sources">{round.contextSummary.items.map((item) => <span key={item.id}><b>{item.title}</b><small>{item.kind} · 约 {item.estimatedTokens} tokens</small></span>)}</div>{round.resolvedReasoning && <p>推理：{round.resolvedReasoning.requestedProfile} → {round.resolvedReasoning.resolvedProfile} · {JSON.stringify(round.resolvedReasoning.native)}</p>}{round.providerInput && <details className="provider-input-facts"><summary>完整 Provider Input · {round.providerInputBytes ?? "—"} bytes · <code>{round.providerInputHash?.slice(0, 12)}</code></summary><pre>{round.providerInput.value}</pre></details>}</details>)}</details>;
}
function Summary({ experiment, scorecard }: { experiment: EvalExperiment; scorecard: ExperimentScorecard | null }) { if (!scorecard || scorecard.status !== "complete") return <Center title="评分卡尚未完成" detail="完成人工标注且 Runtime 必需指标可用后，才生成四维总分、排名与 winner。" />; return <section className="summary-grid"><div className="radar-card"><header><BarChart3 size={16} /><div><strong>四维雷达图</strong><small>理解、规划、输出、执行各占 25%</small></div></header><Radar scorecard={scorecard} experiment={experiment} /></div><div className="score-ledger"><header><strong>排名</strong><small>{scorecard.winnerVariantIds?.length && scorecard.winnerVariantIds.length > 1 ? "并列 winner" : "winner"}</small></header>{scorecard.ranking?.map((row) => <article key={`${row.rank}:${row.totalScore}`}><b>#{row.rank}</b><span>{row.variantIds.map((id) => experiment.variants.find((item) => item.variantId === id)?.label ?? id).join(" / ")}</span><strong>{row.totalScore}</strong></article>)}</div></section>; }
function Radar({ scorecard, experiment }: { scorecard: ExperimentScorecard; experiment: EvalExperiment }) { const center = 120; const radius = 86; const axes = ["understanding", "planning", "output", "execution"] as const; const labels = ["理解", "规划", "输出", "执行"]; function point(index: number, value: number) { const angle = -Math.PI / 2 + index * Math.PI / 2; return `${center + Math.cos(angle) * radius * value / 100},${center + Math.sin(angle) * radius * value / 100}`; } return <svg aria-label="四维评分雷达图" viewBox="0 0 240 240">{[.25,.5,.75,1].map((scale) => <polygon className="radar-grid" key={scale} points={axes.map((_, i) => point(i, scale * 100)).join(" ")} />)}{scorecard.variants.map((variant, index) => <polygon className={`radar-series series-${index}`} key={variant.variantId} points={axes.map((axis, i) => point(i, variant.dimensionScores[axis] ?? 0)).join(" ")} />)}{labels.map((label, index) => { const [x,y] = point(index, 118).split(","); return <text key={label} x={x} y={y}>{label}</text>; })}<g className="radar-legend">{scorecard.variants.map((variant, index) => <text key={variant.variantId} x="12" y={212 + index * 12}>{experiment.variants.find((item) => item.variantId === variant.variantId)?.label} · {variant.totalScore}</text>)}</g></svg>; }

function normalizeExperiment(raw: AnyExperimentRecord): EvalExperiment {
  if (raw.schemaVersion === 1) return {
    experimentId: raw.experimentId, name: raw.name, promptText: raw.promptText, status: raw.status,
    ...(raw.savedAt ? { savedAt: raw.savedAt } : {}), legacy: true,
    variants: raw.variants.map((item) => ({ variantId: item.variantId, label: item.label, subtitle: item.mode === "reuse_snapshot" ? "旧版历史快照" : "旧版 Runtime" })),
    runs: raw.runs.map((run) => ({ variantId: run.variantId, status: run.status, answerTexts: run.answerTexts, ...(run.executionMetrics ? { executionMetrics: run.executionMetrics } : {}), ...(run.runtimeFacts ? { runtimeFacts: run.runtimeFacts } : {}), ...(run.error ? { error: run.error } : {}) })),
    ...(raw.annotationWorksheet ? { annotationWorksheet: raw.annotationWorksheet } : {}),
  };
  return {
    experimentId: raw.experimentId, name: raw.name, promptText: raw.promptText, status: raw.status,
    ...(raw.savedAt ? { savedAt: raw.savedAt } : {}), legacy: false, worksheetModelStudentId: raw.worksheetModelStudentId,
    variants: raw.tests.map((test) => { const snapshot = raw.snapshots?.find((item) => item.testId === test.testId); return {
      variantId: test.testId, label: test.label, subtitle: "全新 Session · 真实 Runtime",
      ...(snapshot ? { model: { display: snapshot.model.model, provider: snapshot.model.providerKind }, reasoning: { requested: snapshot.reasoning.requestedProfile, resolved: snapshot.reasoning.resolvedProfile, native: JSON.stringify(snapshot.reasoning.native) } } : {}),
    }; }),
    runs: raw.runs.map((run) => ({ variantId: run.testId, status: run.status, answerTexts: run.answerTexts, ...(run.executionMetrics ? { executionMetrics: run.executionMetrics } : {}), ...(run.runtimeFacts ? { runtimeFacts: run.runtimeFacts } : {}), ...(run.error ? { error: run.error } : {}), ...(run.hadHumanIntervention ? { hadHumanIntervention: true } : {}) })),
    ...(raw.annotationWorksheet ? { annotationWorksheet: raw.annotationWorksheet } : {}),
  };
}
function elicitationComplete(intervention: ElicitationIntervention, form: Record<string, unknown>): boolean { return intervention.fields.filter((item) => item.required).every((item) => form[item.name] !== undefined && form[item.name] !== ""); }
function toolStreamEntry(toolCallId: string, name: string, status: string) { return `${toolCallId}\t${name} · ${status}`; }
function updateToolStreamEntry(entry: string, toolCallId: string, status: string) { const prefix = `${toolCallId}\t`; if (!entry.startsWith(prefix)) return entry; const name = entry.slice(prefix.length).split(" · ")[0] ?? "Tool"; return toolStreamEntry(toolCallId, name, status); }
function toolStreamLabel(entry: string) { return entry.includes("\t") ? entry.slice(entry.indexOf("\t") + 1) : entry; }
function worksheetGeneratorLabel(worksheet: ExperimentAnnotationWorksheet) { const value = worksheet.generator; return `整理模型 ${value.modelStudentId} · ${value.providerKind} · ${value.model}`; }
function terminalStatus(status: string) { return ["completed", "partially_failed", "failed", "cancelled", "interrupted"].includes(status); }
function Center({ title, detail, retry }: { title: string; detail: string; retry?: () => void }) { return <main className="centered-state"><div><Beaker size={20} /><h1>{title}</h1><p>{detail}</p>{retry && <button type="button" onClick={retry}>重试</button>}</div></main>; }
function isAnnotationTab(tab: Tab): tab is AnnotationTab { return tab === "understanding" || tab === "planning" || tab === "output"; }
function tabLabel(tab: Tab) { return ({ answers: "回答对比", understanding: "需求理解", planning: "Workflow 规划", output: "有效输出", execution: "执行能力", summary: "四维汇总" })[tab]; }
function message(value: unknown) { return value instanceof Error ? value.message : String(value); }
