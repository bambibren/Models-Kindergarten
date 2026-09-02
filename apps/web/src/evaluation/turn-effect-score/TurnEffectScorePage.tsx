import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  BarChart3,
  BrainCircuit,
  Check,
  Gauge,
  Highlighter,
  MessageSquareText,
  Route,
  Save,
  ShieldCheck,
} from "lucide-react";
import { calculateExecutionScores } from "@kindergarten/contracts";
import type {
  TurnEffectScoreDraft,
  TurnEffectScoreRecord,
  TurnEvaluationRecord,
} from "@kindergarten/evaluation-contract";
import { controlApi, type SessionHistoryEntry, type SessionTurnPage } from "../../api/control-api.js";
import { projectSessionTurnPage } from "../../chat/session-history-page.js";
import { ChatBlockList } from "../../components/chat/ChatBlockList.js";
import { ExecutionTrace } from "../demo/agent-evaluation/ExecutionTrace.js";
import { RequirementSelector } from "../demo/agent-evaluation/RequirementSelector.js";
import { SectionHeading } from "../demo/agent-evaluation/SectionHeading.js";
import { ArtifactOutputScore, publishedArtifactRefs } from "../experiment/ArtifactOutputScore.js";
import { ExperimentTabs, type ExperimentTabId } from "../experiment/ExperimentTabs.js";
import { OutputTextMarker } from "../experiment/OutputTextMarker.js";
import { toDemoExecution } from "../experiment/execution-summary.js";
import { WorkflowPlanningScore } from "../experiment/WorkflowPlanningScore.js";
import "../experiment/experiment-evaluation.css";
import "./turn-effect-score.css";

type RequirementVerdict = "met" | "missed" | "unmarked";

interface SourceTurn {
  page: SessionTurnPage;
  turn: SessionTurnPage["turns"][number];
}

/** 已有 Turn 只读取真实历史和 Trace，不创建 Session、不运行实验。 */
export function TurnEffectScorePage({ record, sessionId, turnId }: {
  record: TurnEvaluationRecord;
  sessionId: string;
  turnId: string;
}) {
  return <TurnEffectScorePageInner record={record} sessionId={sessionId} turnId={turnId} />;
}

function TurnEffectScorePageInner({ record, sessionId, turnId }: {
  record: TurnEvaluationRecord;
  sessionId: string;
  turnId: string;
}) {
  const [source, setSource] = useState<SourceTurn | null>(null);
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState<ExperimentTabId>("answers");
  const [selectedRequirementIds, setSelectedRequirementIds] = useState<string[]>([]);
  const [hasOtherRequirement, setHasOtherRequirement] = useState(false);
  const [listedRequirementsWeight, setListedRequirementsWeight] = useState(80);
  const [requirementVerdicts, setRequirementVerdicts] = useState<Record<string, RequirementVerdict>>({});
  const [planningScore, setPlanningScore] = useState<number | undefined>();
  const [outputMarks, setOutputMarks] = useState<TurnEffectScoreDraft["annotations"]["output"]["marks"]>([]);
  const [artifactScore, setArtifactScore] = useState<number | undefined>();
  const [outputTouched, setOutputTouched] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveMessage, setSaveMessage] = useState("");

  useEffect(() => {
    let disposed = false;
    void Promise.all([findTurnPage(sessionId, turnId), controlApi.turnEffectScore(turnId)])
      .then(([nextSource, saved]) => {
        if (disposed) return;
        setSource(nextSource);
        if (saved) restore(saved);
      })
      .catch((error: unknown) => {
        if (!disposed) setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => { disposed = true; };
  }, [sessionId, turnId]);

  const entries = source?.turn.entries ?? [];
  const promptEntry = entries.find((entry) => entry.type === "message" && entry.role === "user");
  const prompt = promptEntry?.type === "message" ? promptEntry.text : "";
  const answer = entries.flatMap((entry) => entry.type === "message" && entry.role === "assistant" ? [entry.text] : []).join("\n");
  const requirements = useMemo(() => promptRequirements(prompt), [prompt]);
  const planningSteps = useMemo(() => thoughtPlanningSteps(entries), [entries]);
  const artifacts = useMemo(() => publishedArtifactRefs(entries), [entries]);
  const collection = useMemo(() => source ? projectSessionTurnPage({
    ...source.page,
    turns: [source.turn],
    hasMore: false,
  }) : null, [source]);
  const executionScore = useMemo(() => automaticExecutionScore(record), [record]);
  const understanding = useMemo(() => selectedRequirements(
    requirements,
    selectedRequirementIds,
    hasOtherRequirement,
    listedRequirementsWeight,
    requirementVerdicts,
  ), [requirements, selectedRequirementIds, hasOtherRequirement, listedRequirementsWeight, requirementVerdicts]);
  const understandingScore = weightedUnderstandingScore(understanding);
  const outputScore = artifacts.length > 0 ? artifactScore ?? 0 : outputCoverageScore(answer, outputMarks);
  const completed = {
    understanding: understanding.length > 0 && understanding.every((item) => item.verdict !== "unmarked"),
    planning: planningScore !== undefined,
    output: artifacts.length > 0 ? artifactScore !== undefined : outputTouched,
  };

  function restore(saved: TurnEffectScoreRecord): void {
    const restored = saved.annotations.understanding.requirements;
    setSelectedRequirementIds(restored.filter((item) => item.requirementId !== "manual-other").map((item) => item.requirementId));
    const other = restored.find((item) => item.requirementId === "manual-other");
    setHasOtherRequirement(Boolean(other));
    setListedRequirementsWeight(listedWeight(restored));
    setRequirementVerdicts(Object.fromEntries(restored.map((item) => [item.requirementId, item.verdict])));
    setPlanningScore(saved.annotations.planning.score);
    setOutputMarks(saved.annotations.output.marks);
    setArtifactScore(saved.annotations.output.artifactScore);
    setOutputTouched(saved.annotations.output.completed);
    setDirty(false);
    setSaveState("saved");
    setSaveMessage(`已保存于 ${new Date(saved.savedAt).toLocaleString("zh-CN")}`);
  }

  function changed(): void {
    setDirty(true);
    setSaveState("idle");
    setSaveMessage("");
  }

  function toggleRequirement(requirementId: string): void {
    setSelectedRequirementIds((current) => current.includes(requirementId)
      ? current.filter((id) => id !== requirementId)
      : [...current, requirementId]);
    changed();
  }

  async function save(): Promise<void> {
    if (!dirty || saveState === "saving") return;
    setSaveState("saving");
    setSaveMessage("");
    const draft: TurnEffectScoreDraft = {
      schemaVersion: 1,
      annotations: {
        understanding: { requirements: understanding, completed: completed.understanding },
        planning: { ...(planningScore === undefined ? {} : { score: planningScore }), completed: completed.planning },
        output: {
          score: outputScore,
          marks: outputMarks,
          ...(artifactScore === undefined ? {} : { artifactScore }),
          completed: completed.output,
        },
      },
    };
    try {
      const saved = await controlApi.saveTurnEffectScore(turnId, draft);
      setDirty(false);
      setSaveState("saved");
      setSaveMessage(`已保存于 ${new Date(saved.savedAt).toLocaleString("zh-CN")}`);
    } catch (error) {
      setSaveState("error");
      setSaveMessage(error instanceof Error ? error.message : String(error));
    }
  }

  if (loadError) return <State title="无法读取效果打分材料" detail={loadError} />;
  if (!source || !collection) return <State title="正在读取效果打分" detail="正在装载所选 Turn 的真实消息与已保存标注…" />;

  return <main className="experiment-shell turn-effect-score-shell">
    <header>
      <button aria-label="返回聊天" onClick={() => history.back()} type="button"><ArrowLeft size={16} /></button>
      <div><span>TURN EFFECT SCORE</span><h1>效果打分</h1></div>
      <button className={`save ${saveState}`} disabled={!dirty || saveState === "saving"} onClick={() => void save()} type="button">
        {saveState === "saved" ? <Check size={14} /> : <Save size={14} />}
        {saveState === "saving" ? "正在保存" : saveState === "saved" && !dirty ? "已保存" : "保存打分"}
      </button>
    </header>

    <section className="experiment-task turn-score-task">
      <div><span>USER PROMPT</span><strong>{prompt || "该 Turn 没有可显示的用户 Prompt"}</strong></div>
      <em>已完成 Turn</em>
      <code title={turnId}>{shortId(turnId)}</code>
    </section>

    <ExperimentTabs
      active={tab}
      answerLabel="流式消息"
      answerStatus="completed"
      executionStatus="completed"
      annotationStatus="ready"
      completed={completed}
      onChange={setTab}
    />

    {tab === "answers" && <section className="annotation-panel raw-answer-panel">
      <SectionHeading icon={<MessageSquareText size={16} />} title="流式消息" detail="复用会话页消息组件，按本 Turn 的上下文、思考、工具与回答原始顺序展示。" />
      <div className="single-turn-card"><div className="chat-content experiment-chat-content"><ChatBlockList
        artifactNavigation={{ href: (artifactId) => `/artifacts/${encodeURIComponent(artifactId)}` }}
        collection={collection}
      /></div></div>
    </section>}

    {tab === "execution" && <section className="annotation-panel">
      <SectionHeading icon={<ShieldCheck size={16} />} title="执行能力" detail="直接使用该 Turn 已生成的 Runtime Evaluation Trace，不重新运行任务。" />
      <div className="single-turn-card execution-single"><div className="single-score"><span>Runtime 自动评分</span><strong>{executionScore}</strong><small>/ 100</small></div><ExecutionTrace execution={{ ...toDemoExecution({ variantId: turnId, status: "completed" }, record), score: executionScore }} /></div>
    </section>}

    {tab === "understanding" && <TurnUnderstandingPanel
      hasOtherRequirement={hasOtherRequirement}
      listedRequirementsWeight={listedRequirementsWeight}
      requirements={requirements}
      selectedRequirementIds={selectedRequirementIds}
      onOtherRequirementToggle={() => { setHasOtherRequirement((current) => !current); changed(); }}
      onToggle={toggleRequirement}
      onWeightChange={(value) => { setListedRequirementsWeight(value); changed(); }}
    />}

    {tab === "planning" && <section className="annotation-panel">
      <SectionHeading icon={<Route size={16} />} title="Workflow 规划能力评分" detail="只读材料来自该 Turn 的真实思考消息；滑块评分不会改变或重跑 Turn。" />
      <div className="single-turn-card"><WorkflowPlanningScore steps={planningSteps} score={planningScore} variantId={turnId} onChange={(value) => { setPlanningScore(value); changed(); }} /></div>
    </section>}

    {tab === "output" && <section className="annotation-panel">
      <SectionHeading icon={<Highlighter size={16} />} title="最终有效输出结果 标注" detail="有已发布产物时对产物整体评分；否则在最终回答中拖选有效或部分有效文本。" />
      <div className="single-turn-card output-single">{artifacts.length > 0
        ? <ArtifactOutputScore artifacts={artifacts} score={artifactScore ?? 0} variantId={turnId} onChange={(value) => { setArtifactScore(value); setOutputTouched(true); changed(); }} />
        : <><div className="single-score"><span>当前输出得分</span><strong>{outputScore}</strong><small>/ 100</small></div><OutputTextMarker
          variantId={turnId}
          sections={answer ? [{ answerSectionId: "final-answer", label: "最终回答", start: 0, end: answer.length, text: answer }] : []}
          marks={outputMarks.map((mark) => ({ ...mark, variantId: turnId }))}
          onChange={(marks) => {
            setOutputMarks(marks.filter((mark) => mark.verdict !== "none").map(({ variantId: _variantId, ...mark }) => ({
              ...mark,
              verdict: mark.verdict as "effective" | "partial",
            })));
            setOutputTouched(true);
            changed();
          }}
        /></>}
      </div>
    </section>}

    {tab === "summary" && <TurnScoreSummary scores={{ understanding: understandingScore, planning: planningScore ?? 0, output: outputScore, execution: executionScore }} />}
    {saveMessage && <p className={`turn-save-message ${saveState}`}>{saveMessage}</p>}
  </main>;
}

/** 单 Turn 理解页只复用真实需求选择，不额外发明一套逐条 verdict 小模块。 */
export function TurnUnderstandingPanel({ requirements, selectedRequirementIds, hasOtherRequirement, listedRequirementsWeight, onToggle, onOtherRequirementToggle, onWeightChange }: {
  requirements: Array<{ requirementId: string; label: string }>;
  selectedRequirementIds: string[];
  hasOtherRequirement: boolean;
  listedRequirementsWeight: number;
  onToggle: (requirementId: string) => void;
  onOtherRequirementToggle: () => void;
  onWeightChange: (value: number) => void;
}) {
  return <section className="annotation-panel understanding-panel"><div className="turn-understanding-workspace">
    <SectionHeading icon={<BrainCircuit size={16} />} title="需求理解能力 打分" detail="候选项仅从用户 Prompt 的显式分行提取；选择本次评测中的真实需求。" />
    <RequirementSelector
      requirements={requirements.map((item) => ({ id: item.requirementId, label: item.label, sources: ["用户 Prompt"] }))}
      selectedIds={selectedRequirementIds}
      hasOtherRequirement={hasOtherRequirement}
      listedRequirementsWeight={listedRequirementsWeight}
      onToggle={onToggle}
      onOtherRequirementToggle={onOtherRequirementToggle}
      onWeightChange={onWeightChange}
      weightMin={1}
      weightMax={99}
    />
  </div></section>;
}

/** 单 Turn 综合页沿用 AB Test 的四维等权总分口径，但不产生排名。 */
export function TurnScoreSummary({ scores }: { scores: Record<"understanding" | "planning" | "output" | "execution", number> }) {
  const axes = [
    ["understanding", "理解能力"],
    ["planning", "规划能力"],
    ["output", "输出结果"],
    ["execution", "执行能力"],
  ] as const;
  const totalScore = turnTotalScore(scores);
  const point = (index: number, value: number) => {
    const angle = -Math.PI / 2 + index * Math.PI / 2;
    return `${120 + Math.cos(angle) * 82 * value / 100},${120 + Math.sin(angle) * 82 * value / 100}`;
  };
  return <section className="summary-grid turn-summary"><div className="radar-card"><header><BarChart3 size={16} /><div><strong>综合能力分布</strong><small>理解、规划、输出、执行各占 25% · 不进行排名</small></div></header><svg aria-label="单 Turn 综合能力分布" role="img" viewBox="0 0 240 240">
    {[25, 50, 75, 100].map((level) => <polygon className="radar-grid" key={level} points={axes.map((_, index) => point(index, level)).join(" ")} />)}
    <polygon className="radar-series series-0" points={axes.map(([id], index) => point(index, scores[id])).join(" ")} />
    {axes.map(([, label], index) => { const [x, y] = point(index, 118).split(","); return <text key={label} x={x} y={y}>{label}</text>; })}
  </svg></div><div className="score-ledger turn-dimension-ledger"><header className="turn-score-ledger-header"><div><strong>四维评分</strong><small>未完成的人工维度按 0 分显示</small></div><div className="turn-total-score"><span>总分</span><strong>{totalScore}</strong><small>/ 100</small></div></header>{axes.map(([id, label]) => <article key={id}><span>{label}</span><strong>{scores[id]}</strong><small>/ 100</small></article>)}</div></section>;
}

export function turnTotalScore(scores: Record<"understanding" | "planning" | "output" | "execution", number>): number {
  return Math.round((scores.understanding + scores.planning + scores.output + scores.execution) / 4);
}

function State({ title, detail }: { title: string; detail: string }) {
  return <main className="centered-state turn-score-state"><div><Gauge size={20} /><h1>{title}</h1><p>{detail}</p><button onClick={() => history.back()} type="button"><ArrowLeft size={14} />返回</button></div></main>;
}

async function findTurnPage(sessionId: string, turnId: string): Promise<SourceTurn> {
  let beforeTurnId: string | undefined;
  const seen = new Set<string>();
  while (true) {
    const page = await controlApi.sessionTurns(sessionId, beforeTurnId);
    const turn = page.turns.find((item) => item.turnId === turnId);
    if (turn) return { page, turn };
    if (!page.hasMore || !page.nextBeforeTurnId || seen.has(page.nextBeforeTurnId)) break;
    seen.add(page.nextBeforeTurnId);
    beforeTurnId = page.nextBeforeTurnId;
  }
  throw new Error("所选 Turn 不存在或不属于当前 Session");
}

export function promptRequirements(prompt: string): Array<{ requirementId: string; label: string }> {
  const lines = prompt.split(/\r?\n/u).map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/u, "").trim()).filter(Boolean);
  return (lines.length > 0 ? lines : prompt.trim() ? [prompt.trim()] : []).slice(0, 30).map((label, index) => ({ requirementId: `prompt-${index + 1}`, label }));
}

export function thoughtPlanningSteps(entries: SessionHistoryEntry[]) {
  return entries.flatMap((entry) => entry.type === "thought" ? entry.text.split(/\r?\n/u) : [])
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/u, "").trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((label, index) => ({ stepId: `thought-step-${index + 1}`, label }));
}

function selectedRequirements(
  candidates: Array<{ requirementId: string; label: string }>,
  selectedIds: string[],
  hasOther: boolean,
  listedWeightValue: number,
  verdicts: Record<string, RequirementVerdict>,
): TurnEffectScoreDraft["annotations"]["understanding"]["requirements"] {
  const selected = candidates.filter((item) => selectedIds.includes(item.requirementId));
  const listedShare = hasOther ? (selected.length > 0 ? listedWeightValue : 0) : 100;
  const weight = selected.length > 0 ? listedShare / selected.length : 0;
  return [
    ...selected.map((item) => ({ ...item, weight, verdict: verdicts[item.requirementId] ?? "unmarked" as const })),
    ...(hasOther ? [{ requirementId: "manual-other", label: "其他需求", weight: 100 - listedShare, verdict: verdicts["manual-other"] ?? "unmarked" as const }] : []),
  ];
}

function weightedUnderstandingScore(items: TurnEffectScoreDraft["annotations"]["understanding"]["requirements"]): number {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  const met = items.reduce((sum, item) => sum + (item.verdict === "met" ? item.weight : 0), 0);
  return total > 0 ? Math.round(100 * met / total) : 0;
}

function outputCoverageScore(text: string, marks: TurnEffectScoreDraft["annotations"]["output"]["marks"]): number {
  let total = 0;
  let earned = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (/\s/u.test(text[index] ?? "")) continue;
    total += 1;
    const covering = marks.filter((mark) => mark.start <= index && mark.end > index);
    earned += covering.some((mark) => mark.verdict === "effective") ? 1 : covering.some((mark) => mark.verdict === "partial") ? .5 : 0;
  }
  return total === 0 ? 0 : Math.round(100 * earned / total);
}

function automaticExecutionScore(record: TurnEvaluationRecord): number {
  const result = record.result;
  return calculateExecutionScores([{
    evaluationRecordId: `${record.trace.sessionId}:${record.trace.turnId}`,
    variantId: record.trace.turnId,
    normallyCompleted: result.normallyCompleted,
    ...(result.firstTokenLatencyMs === undefined ? {} : { firstTokenLatencyMs: result.firstTokenLatencyMs }),
    totalDurationMs: result.totalDurationMs,
    toolUseWasExpected: result.toolCallCount > 0,
    toolSuccessCount: result.toolSuccessCount,
    toolFailureCount: result.toolFailureCount,
    errorCount: result.errorCount,
    permissionViolationCount: result.permissionViolationCount,
    hasRepeatedToolCall: result.hasRepeatedToolCall,
    modelRoundCount: result.modelRoundCount,
    toolCallCount: result.toolCallCount,
    totalContextTokens: result.totalContextTokens,
    totalOutputTokens: result.totalOutputTokens,
  }])[0]?.score ?? 0;
}

function listedWeight(requirements: TurnEffectScoreRecord["annotations"]["understanding"]["requirements"]): number {
  const other = requirements.find((item) => item.requirementId === "manual-other");
  return other ? Math.max(1, Math.min(99, Math.round(100 - other.weight))) : 80;
}

function shortId(value: string): string { return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-5)}` : value; }
