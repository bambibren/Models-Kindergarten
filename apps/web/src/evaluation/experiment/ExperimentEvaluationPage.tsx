import { ArrowLeft, BarChart3, Beaker, BookmarkCheck, BookmarkPlus, BrainCircuit, Braces, Check, Highlighter, MessageSquareText, RefreshCw, Route, ShieldCheck, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type * as acp from "@agentclientprotocol/sdk";
import type { TurnEvaluationRecord } from "@kindergarten/evaluation-contract";
import type {
  AnyExperimentRecord,
  ExperimentAnnotationWorksheet,
  ExperimentScorecard,
  OutputAnnotationFacts,
  PlanningAnnotationFacts,
  UnderstandingAnnotationFacts,
  LiveExecutionNotification,
  TurnStateNotification,
} from "@kindergarten/contracts";
import { calculateExecutionScores } from "@kindergarten/contracts";
import { experimentApi } from "../experiment-api.js";
import { ExperimentAcpClient, type ElicitationIntervention, type ExperimentIntervention } from "../experiment-acp-client.js";
import { acpWebSocketUrl } from "../../deployment-endpoints.js";
import { controlApi, type SessionHistoryEntry } from "../../api/control-api.js";
import { ChatBlockList } from "../../components/chat/ChatBlockList.js";
import { chatReducer, emptyChat } from "../../chat/chat-reducer.js";
import { projectSessionTurnPage } from "../../chat/session-history-page.js";
import { emptyEntries, type ChatState, type EntryCollection } from "../../chat/chat-types.js";
import { loadTurnEvaluation } from "../api.js";
import { ExecutionTrace } from "../demo/agent-evaluation/ExecutionTrace.js";
import { RequirementSelector } from "../demo/agent-evaluation/RequirementSelector.js";
import { SectionHeading } from "../demo/agent-evaluation/SectionHeading.js";
import { toDemoExecution, type ExecutionTraceRun } from "./execution-summary.js";
import {
  reduceLiveExecution,
  finishLiveExecution,
  startLiveExecution,
  toLiveDemoExecution,
  type LiveExecutionState,
} from "./live-execution.js";
import { OutputTextMarker } from "./OutputTextMarker.js";
import { ExperimentLaneContext } from "./ExperimentLaneContext.js";
import { ExperimentTabs, isAnnotationTab, type ExperimentTabId } from "./ExperimentTabs.js";
import { ArtifactOutputScore, publishedArtifactRefs, type OutputArtifactRef } from "./ArtifactOutputScore.js";
import { WorkflowPlanningScore } from "./WorkflowPlanningScore.js";
import "./experiment-evaluation.css";

const ACP_URL = acpWebSocketUrl();
type Phase = "loading" | "ready" | "running" | "error";
type Tab = ExperimentTabId;

interface EvalRun extends ExecutionTraceRun {
  acpSessionId?: string;
  turnId?: string;
  answerTexts: string[];
  hadHumanIntervention?: boolean;
}
interface EvalVariant {
  variantId: string;
  label: "A" | "B" | "C";
  subtitle: string;
  model?: { display: string; provider: string };
  reasoning?: { requested: string; resolved: string; native: string };
  contextConfiguration?: unknown;
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
}

/** 渲染「ExperimentEvaluationPage」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function ExperimentEvaluationPage({ experimentId }: { experimentId: string }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState("");
  const [experiment, setExperiment] = useState<EvalExperiment | null>(null);
  const [scorecard, setScorecard] = useState<ExperimentScorecard | null>(null);
  const [streams, setStreams] = useState<Record<string, ChatState>>({});
  const [sessionEntries, setSessionEntries] = useState<Record<string, SessionHistoryEntry[]>>({});
  const [sessionCollections, setSessionCollections] = useState<Record<string, EntryCollection>>({});
  const [runEvaluations, setRunEvaluations] = useState<Record<string, TurnEvaluationRecord | null>>({});
  const [liveExecutions, setLiveExecutions] = useState<Record<string, LiveExecutionState>>({});
  const [interventions, setInterventions] = useState<Record<string, ExperimentIntervention[]>>({});
  const client = useRef<ExperimentAcpClient | null>(null);
  const sessionVariants = useRef(new Map<string, string>());
  const terminalEvaluationLoads = useRef(new Set<string>());

  const load = useCallback(/** 缓存「load」的派生计算，依赖变化时重新生成以避免陈旧闭包。 */
async () => {
    setPhase("loading"); setError("");
    try {
      const raw = await experimentApi.get(experimentId);
      const value = normalizeExperiment(raw);
      setExperiment(value);
      const presentations = await Promise.all(value.runs.map(async (run) => {
        if (!run.acpSessionId || !run.turnId) return [run.variantId, [] as SessionHistoryEntry[], emptyEntries(), null] as const;
        const [page, evaluation] = await Promise.all([
          controlApi.sessionTurns(run.acpSessionId).catch(() => null),
          loadTurnEvaluation(run.acpSessionId, run.turnId).catch(() => null),
        ]);
        const turn = page?.turns.find((item) => item.turnId === run.turnId);
        const entries = turn?.entries ?? [];
        const collection = page && turn ? projectSessionTurnPage({ ...page, turns: [turn] }) : emptyEntries();
        return [run.variantId, entries, collection, evaluation] as const;
      }));
      setSessionEntries(Object.fromEntries(presentations.map(([variantId, entries]) => [variantId, entries])));
      setSessionCollections(Object.fromEntries(presentations.map(([variantId, , collection]) => [variantId, collection])));
      setRunEvaluations(Object.fromEntries(presentations.map(([variantId, , , evaluation]) => [variantId, evaluation])));
      const finalized = new Set(presentations.flatMap(([variantId, , , evaluation]) => evaluation ? [variantId] : []));
      setLiveExecutions((current) => Object.fromEntries(Object.entries(current).filter(([variantId]) => !finalized.has(variantId))));
      setStreams({});
      if (terminalStatus(value.status)) {
        try { setScorecard(await experimentApi.scorecard(experimentId)); } catch { setScorecard(null); }
      }
      setPhase("ready");
    } catch (cause) { setError(message(cause)); setPhase("error"); }
  }, [experimentId]);

  useEffect(/** 同步组件生命周期内的外部状态，并在清理阶段释放订阅或临时资源。 */
() => { void load(); }, [load]);
  useEffect(/** 同步组件生命周期内的外部状态，并在清理阶段释放订阅或临时资源。 */
() => /** 同步组件生命周期内的外部状态，并在清理阶段释放订阅或临时资源。 */
() => client.current?.close(), []);

  /** 处理「onUpdate」事件，校验归属后再推进状态且避免重复提交。 */
  function onUpdate(notification: acp.SessionNotification) {
    const variantId = sessionVariants.current.get(notification.sessionId); if (!variantId) return;
    setStreams(/** 处理「onUpdate」事件，校验归属后再推进状态且避免重复提交。 */
(current) => {
      const value = current[variantId];
      return value ? { ...current, [variantId]: chatReducer(value, { type: "acp/update", value: notification }) } : current;
    });
  }

  /** 把当前 ACP 连接收到的 Runtime 执行事件归入对应 Test 的临时轨迹。 */
  function onExecution(notification: LiveExecutionNotification) {
    const variantId = sessionVariants.current.get(notification.sessionId); if (!variantId) return;
    setLiveExecutions((current) => {
      const state = current[variantId];
      if (!state) return current;
      const next = reduceLiveExecution(state, notification.event);
      return next === state ? current : { ...current, [variantId]: next };
    });
  }

  /** 单个 Test 收到 Turn 终态后先冻结计时，再独立读取该 Turn 的最终 Evaluation Trace。 */
  function onTurnState(notification: TurnStateNotification) {
    const turn = notification.turn;
    if (turn.status === "active") return;
    const variantId = sessionVariants.current.get(notification.sessionId); if (!variantId) return;
    setLiveExecutions((current) => {
      const state = current[variantId];
      if (!state) return current;
      const next = finishLiveExecution(state, turn);
      return next === state ? current : { ...current, [variantId]: next };
    });

    const key = `${notification.sessionId}:${turn.turnId}`;
    if (terminalEvaluationLoads.current.has(key)) return;
    terminalEvaluationLoads.current.add(key);
    void loadTurnEvaluation(notification.sessionId, turn.turnId)
      .then((evaluation) => {
        if (!evaluation) return;
        setRunEvaluations((current) => ({ ...current, [variantId]: evaluation }));
        setLiveExecutions((current) => {
          if (current[variantId]?.turnId !== turn.turnId) return current;
          const { [variantId]: _completed, ...remaining } = current;
          return remaining;
        });
      })
      .catch(() => undefined);
  }

  /** 执行「enqueueIntervention」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function enqueueIntervention(testId: string, intervention: ExperimentIntervention) {
    setInterventions(/** 执行「enqueueIntervention」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(current) => ({ ...current, [testId]: [...(current[testId] ?? []), intervention] }));
  }

  /** 执行「finishIntervention」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async function finishIntervention(testId: string, interventionId: string, content?: string | Record<string, unknown>) {
    const intervention = interventions[testId]?.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.interventionId === interventionId);
    if (!intervention) return;
    if (intervention.kind === "permission") await intervention.respond(typeof content === "string" ? content : undefined);
    else await intervention.respond(typeof content === "object" ? content : undefined);
    setInterventions(/** 执行「finishIntervention」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(current) => ({ ...current, [testId]: (current[testId] ?? []).filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.interventionId !== interventionId) }));
  }

  /** 执行「run」主流程，传播取消与失败并在结束时清理临时资源。 */
async function run() {
    if (!experiment || experiment.legacy || experiment.status !== "prepared" || phase === "running") return;
    setPhase("running"); setError("");
    try {
      client.current ??= await ExperimentAcpClient.open(
        ACP_URL,
        onUpdate,
        onExecution,
        onTurnState,
        enqueueIntervention,
        /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(id, testId, fact) => experimentApi.intervention(id, testId, fact).then(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => undefined),
        /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
() => setError("ACP 连接已断开"),
      );
      const results = await Promise.allSettled(experiment.runs.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
async (run) => {
        try {
          let sessionId: string | undefined;
          try {
            await client.current!.run(experimentId, run.variantId, experiment.promptText, /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(createdSessionId, turnId) => {
              sessionId = createdSessionId;
              sessionVariants.current.set(createdSessionId, run.variantId);
              setLiveExecutions((current) => ({ ...current, [run.variantId]: startLiveExecution(turnId) }));
              setExperiment((current) => current ? {
                ...current,
                status: "running",
                runs: current.runs.map((item) => item.variantId === run.variantId
                  ? { ...item, status: "running", acpSessionId: createdSessionId, turnId }
                  : item),
              } : current);
              const opened = chatReducer(emptyChat, { type: "session/open", sessionId: createdSessionId });
              setStreams((current) => ({ ...current, [run.variantId]: chatReducer(opened, {
                type: "stream/start",
                operationId: `experiment:${experimentId}:${run.variantId}`,
                source: "prompt",
                turnId,
                optimisticContent: [{ type: "text", text: experiment.promptText }],
              }) }));
            });
          } finally {
            if (sessionId) sessionVariants.current.delete(sessionId);
          }
        } catch (cause) {
          await experimentApi.failRun(experimentId, run.variantId).catch(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => undefined);
          throw cause;
        }
      }));
      const problem = results.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.status === "rejected") ? "至少一个 Test 运行失败；本次实验已终止，不能重跑。" : "";
      await load(); if (problem) setError(problem);
    } catch (cause) { setError(message(cause)); setPhase("error"); }
  }

  /** 判断「cancel」对应条件，只返回判定结果且不修改输入状态。 */
async function cancel() {
    setError("正在取消运行中的 Test…");
    await Promise.all([client.current?.cancelAll(), experimentApi.cancel(experimentId)]);
    await load();
  }

  if (phase === "loading") return <Center title="正在读取实验" detail="从 Remote 读取 ExperimentRecord…" />;
  if (phase === "error" || !experiment) return <Center title="无法打开实验" detail={error || "Experiment 不存在"} retry={/** 执行「retry」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => void load()} />;
  return <ExperimentReady key={experiment.annotationWorksheet?.worksheetId ?? experiment.experimentId}
    experiment={experiment} scorecard={scorecard} streams={streams} sessionEntries={sessionEntries} sessionCollections={sessionCollections} runEvaluations={runEvaluations} liveExecutions={liveExecutions} interventions={interventions}
    running={phase === "running"} notice={error} onRun={/** 处理「onRun」事件，校验归属后再推进状态且避免重复提交。 */
() => void run()} onCancel={/** 处理「onCancel」事件，校验归属后再推进状态且避免重复提交。 */
() => void cancel()}
    onIntervention={finishIntervention} onReload={/** 处理「onReload」事件，校验归属后再推进状态且避免重复提交。 */
() => void load()} onScorecard={setScorecard} />;
}

/** 渲染「ExperimentReady」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function ExperimentReady({ experiment, scorecard, streams, sessionEntries, sessionCollections, runEvaluations, liveExecutions, interventions, running, notice, onRun, onCancel, onIntervention, onReload, onScorecard }: {
  experiment: EvalExperiment;
  scorecard: ExperimentScorecard | null;
  streams: Record<string, ChatState>;
  sessionEntries: Record<string, SessionHistoryEntry[]>;
  sessionCollections: Record<string, EntryCollection>;
  runEvaluations: Record<string, TurnEvaluationRecord | null>;
  liveExecutions: Record<string, LiveExecutionState>;
  interventions: Record<string, ExperimentIntervention[]>;
  running: boolean;
  notice: string;
  onRun: () => void;
  onCancel: () => void;
  onIntervention: (testId: string, interventionId: string, content?: string | Record<string, unknown>) => void | Promise<void>;
  onReload: () => void;
  onScorecard: (value: ExperimentScorecard) => void;
}) {
  const [tab, setTab] = useState<Tab>("answers"); const [messageText, setMessageText] = useState("");
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const worksheet = experiment.annotationWorksheet;
  const [selectedRequirementIds, setSelectedRequirementIds] = useState<string[]>(/** 执行「[selectedRequirementIds, setSelectedRequirementIds]」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => scorecard?.annotations.understanding.requirements.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.requirementId).filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(id) => id !== "manual-other") ?? []);
  const [hasOtherRequirement, setHasOtherRequirement] = useState(/** 执行「[hasOtherRequirement, setHasOtherRequirement]」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => scorecard?.annotations.understanding.requirements.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.requirementId === "manual-other") ?? false);
  const [listedRequirementsWeight, setListedRequirementsWeight] = useState(/** 执行「[listedRequirementsWeight, setListedRequirementsWeight]」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => listedWeightFromScorecard(scorecard));
  const selectedWorksheetRequirements = useMemo(/** 只让用户选中的候选需求进入人工理解评分。 */
() => (worksheet?.requirements ?? []).filter((item) => selectedRequirementIds.includes(item.requirementId)), [worksheet, selectedRequirementIds]);
  const requirements = useMemo(/** 根据选择和“其他需求”权重实时形成服务端可校验事实。 */
() => understandingRequirements(selectedWorksheetRequirements, hasOtherRequirement, listedRequirementsWeight), [selectedWorksheetRequirements, hasOtherRequirement, listedRequirementsWeight]);
  const [understandingMarks, setUnderstandingMarks] = useState<UnderstandingAnnotationFacts["marks"]>(/** 执行「[understandingMarks, setUnderstandingMarks]」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => scorecard?.annotations.understanding.marks ?? []);
  const [planningScores, setPlanningScores] = useState<PlanningAnnotationFacts["scores"]>(/** 规划分只从人工滑块恢复，不从 Workflow 步骤推导。 */
() => scorecard?.annotations.planning.scores ?? []);
  const [outputMarks, setOutputMarks] = useState<OutputAnnotationFacts["marks"]>(/** 执行「[outputMarks, setOutputMarks]」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => scorecard?.annotations.output.marks ?? []);
  const [artifactScores, setArtifactScores] = useState<NonNullable<OutputAnnotationFacts["artifactScores"]>>(
    () => scorecard?.annotations.output.artifactScores ?? [],
  );
  const [completed, setCompleted] = useState(/** 执行「[completed, setCompleted]」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => ({ understanding: Boolean(scorecard?.annotations.understanding.completedAt), planning: Boolean(scorecard?.annotations.planning.completedAt), output: Boolean(scorecard?.annotations.output.completedAt) }));
  const [syncRevision, setSyncRevision] = useState(0);
  const [syncState, setSyncState] = useState<"idle" | "syncing" | "synced" | "error">("idle");
  const syncQueue = useRef<Promise<void>>(Promise.resolve());
  const latestSyncRevision = useRef(0);
  const answersComplete = experiment.runs.length > 0 && experiment.runs.every((run) => run.status === "completed");
  const planningCompleted = experiment.runs.length > 0 && experiment.runs.every((run) => planningScores.some((item) => item.variantId === run.variantId));
  const annotationCompleted = { ...completed, planning: planningCompleted };
  const executionStatus = experiment.runs.some((run) => run.status === "pending" || run.status === "session_created" || run.status === "running")
    ? "loading" as const
    : experiment.runs.length > 0 && experiment.runs.every((run) => run.status === "completed") ? "completed" as const : "failed" as const;
  const autoWorksheetEligible = !experiment.legacy && !worksheet && answersComplete && executionStatus === "completed";
  const [worksheetGeneration, setWorksheetGeneration] = useState<"waiting" | "generating" | "failed">(
    () => autoWorksheetEligible ? "generating" : "waiting",
  );
  const autoWorksheetRequested = useRef(false);
  const annotationStatus = worksheet ? "ready" as const : worksheetGeneration === "generating" ? "loading" as const : "blocked" as const;
  const answers = useMemo(/** 缓存「answers」的派生计算，依赖变化时重新生成以避免陈旧闭包。 */
() => Object.fromEntries(experiment.runs.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(run) => [run.variantId, run.answerTexts.join("\n") || historyAnswer(sessionEntries[run.variantId] ?? []) || assistantText(streams[run.variantId]?.streamingChatEntries) || ""])), [experiment, sessionEntries, streams]);
  const outputArtifacts = useMemo(() => Object.fromEntries(experiment.runs.map((run) => [
    run.variantId,
    publishedArtifactRefs(sessionEntries[run.variantId] ?? []),
  ])), [experiment.runs, sessionEntries]);
  /** 回答与执行都完成后只自动发起一次题目生成；服务端已有工作表时会幂等返回。 */
  useEffect(() => {
    if (!autoWorksheetEligible || autoWorksheetRequested.current) return;
    autoWorksheetRequested.current = true;
    void generateWorksheet();
  }, [autoWorksheetEligible, experiment.experimentId]);
  /** 人工事实变化后短暂合并高频操作，再按顺序写回 Remote 并刷新四维评分。 */
  useEffect(() => {
    if (!worksheet || experiment.legacy || !answersComplete || syncRevision === 0) return;
    latestSyncRevision.current = syncRevision;
    const timer = window.setTimeout(() => {
      const revision = syncRevision;
      const now = new Date().toISOString();
      const request = syncQueue.current.then(async () => {
        setSyncState("syncing");
        const value = await experimentApi.annotations(experiment.experimentId, {
          understanding: { requirements, marks: understandingMarks, ...(completed.understanding ? { completedAt: now } : {}) },
          planning: { scores: planningScores, ...(planningCompleted ? { completedAt: now } : {}) },
          output: { marks: outputMarks, artifactScores, ...(completed.output ? { completedAt: now } : {}) },
        });
        if (latestSyncRevision.current === revision) {
          onScorecard(value);
          setSyncState("synced");
        }
      });
      syncQueue.current = request.catch(() => undefined);
      void request.catch((cause: unknown) => {
        if (latestSyncRevision.current === revision) {
          setSyncState("error");
          setMessageText(message(cause));
        }
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [answersComplete, artifactScores, completed, experiment.experimentId, experiment.legacy, onScorecard, outputMarks, planningCompleted, planningScores, requirements, syncRevision, understandingMarks, worksheet]);

  /** 标记一次人工操作；评分同步由 effect 统一节流并串行化。 */
  function markAnnotationsDirty() { setMessageText(""); setSyncRevision((current) => current + 1); }
  /** 选择一次真实需求，并用工作表中的客观覆盖映射同步生成各 Test 的既有理解标记。 */
  function toggleRequirement(requirementId: string) {
    if (!worksheet) return;
    const selected = selectedRequirementIds.includes(requirementId);
    const nextIds = selected ? selectedRequirementIds.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(id) => id !== requirementId) : [...selectedRequirementIds, requirementId];
    const requirement = worksheet.requirements.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.requirementId === requirementId);
    setSelectedRequirementIds(nextIds);
    setUnderstandingMarks(/** 更新人工选择对应的标记集合；旧工作表没有覆盖映射时保留已保存 verdict。 */
(current) => {
      const preserved = current.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.requirementId !== requirementId);
      if (selected || !requirement) return preserved;
      return [...preserved, ...experiment.runs.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(run) => ({
        variantId: run.variantId,
        requirementId,
        verdict: current.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.requirementId === requirementId && item.variantId === run.variantId)?.verdict
          ?? (requirement.matchedVariantIds?.includes(run.variantId) ? "met" as const : "missed" as const),
      }))];
    });
    setCompleted((current) => ({ ...current, understanding: nextIds.length > 0 || hasOtherRequirement }));
    markAnnotationsDirty();
  }
  /** “其他需求”沿用 Demo 的权重语义；它不伪造任何 Test 命中，默认映射为 missed。 */
  function toggleOtherRequirement() {
    const next = !hasOtherRequirement;
    setHasOtherRequirement(next);
    setUnderstandingMarks((current) => next
      ? [...current.filter((item) => item.requirementId !== "manual-other"), ...experiment.runs.map((run) => ({ variantId: run.variantId, requirementId: "manual-other", verdict: "missed" as const }))]
      : current.filter((item) => item.requirementId !== "manual-other"));
    setCompleted((current) => ({ ...current, understanding: selectedRequirementIds.length > 0 || next }));
    markAnnotationsDirty();
  }
  /** 更新「save」对应状态，并保持写入顺序、原子性与容量约束。 */
async function save() { try { await experimentApi.save(experiment.experimentId); setMessageText("已保存到“我的对照实验”。"); onReload(); } catch (cause) { setMessageText(message(cause)); } }
  /** 执行「generateWorksheet」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async function generateWorksheet(force = false) { if (experiment.legacy) return; setWorksheetGeneration("generating"); try { setMessageText(force ? "正在重新调用配置模型生成评测材料…" : "正在自动调用配置模型生成评测材料…"); await experimentApi.worksheet(experiment.experimentId, force); setConfirmRegenerate(false); setMessageText("评测材料已生成。"); onReload(); } catch (cause) { setWorksheetGeneration("failed"); setMessageText(message(cause)); } }
  return <div className="experiment-shell"><header><button aria-label="返回" type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => history.back()}><ArrowLeft size={17} /></button><div><span>MODEL CONTEXT · COMPARISON</span><h1>{experiment.name}</h1></div>{!experiment.legacy && <button className="save" disabled={Boolean(experiment.savedAt)} type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => void save()}>{experiment.savedAt ? <BookmarkCheck size={14} /> : <BookmarkPlus size={14} />}{experiment.savedAt ? "已保存" : "保存本次结果"}</button>}</header>
    <section className="experiment-task"><div><span>USER TASK · {experiment.legacy ? "旧版实验语义" : "V2 单轮"}</span><strong>{experiment.promptText}</strong></div><em>{experiment.status}</em>{!experiment.legacy && experiment.status === "prepared" && !running && <button type="button" onClick={onRun}><Beaker size={14} />运行全部 Test</button>}{running && <button className="cancel-run" type="button" onClick={onCancel}>取消运行</button>}</section>
    {experiment.legacy && <div className="experiment-message">旧实验只读保留；不提供重跑、转换、克隆或重置。</div>}
    <ExperimentTabs active={tab} answerStatus={answersComplete ? "completed" : "loading"} executionStatus={executionStatus} annotationStatus={annotationStatus} completed={annotationCompleted} onChange={setTab} />
    {tab === "answers" && <section className="annotation-panel raw-answer-panel"><PanelHeading icon={<MessageSquareText size={16} />} title="原始回答" detail="回答生成期间可同步查看执行能力，人工标注与综合模块在消息流结束后开放；点击 Test 标题可展开完整上下文配置。" /><LaneGrid contextDisclosure experiment={experiment} interventions={interventions} onIntervention={onIntervention} showInterventions>{(run) => <ExperimentMessageFlow
      history={sessionCollections[run.variantId] ?? emptyEntries()}
      live={streams[run.variantId]?.streamingChatEntries ?? emptyEntries()}
      run={run}
    />}</LaneGrid></section>}
    {isAnnotationTab(tab) && !worksheet && (experiment.legacy ? <Center title="旧实验没有标注工作表" detail="旧记录保持原样，不会为其补跑或补生成工作表。" /> : <WorksheetGate ready={experiment.runs.every(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
    (run) => run.status === "completed")} message={messageText || notice} onGenerate={/** 处理「onGenerate」事件，校验归属后再推进状态且避免重复提交。 */
() => void generateWorksheet()} />)}
    {tab === "understanding" && worksheet && <Understanding experiment={experiment} hasOtherRequirement={hasOtherRequirement} listedRequirementsWeight={listedRequirementsWeight} marks={understandingMarks} requirements={requirements} selectedRequirementIds={selectedRequirementIds} worksheet={worksheet} onOtherRequirementToggle={toggleOtherRequirement} onToggle={toggleRequirement} onWeightChange={/** 处理「onWeightChange」事件，校验归属后再推进状态且避免重复提交。 */
    (value) => { setListedRequirementsWeight(value); setCompleted((current) => ({ ...current, understanding: true })); markAnnotationsDirty(); }} />}
    {tab === "planning" && worksheet && <Planning experiment={experiment} worksheet={worksheet} scores={planningScores} onScoreChange={/** 每次拖动只写入当前 Test 的人工主观分。 */
    (variantId, score) => {
      setPlanningScores((current) => [...current.filter((item) => item.variantId !== variantId), { variantId, score }]);
      markAnnotationsDirty();
    }} />}
    {tab === "output" && worksheet && <Output answers={answers} artifactScores={artifactScores} artifacts={outputArtifacts} experiment={experiment} worksheet={worksheet} marks={outputMarks} onArtifactScoreChange={/** 处理「onArtifactScoreChange」事件，校验归属后再推进状态且避免重复提交。 */
(variantId, score) => {
      setArtifactScores((current) => [...current.filter((item) => item.variantId !== variantId), { variantId, score }]);
      setCompleted((status) => ({ ...status, output: true }));
      markAnnotationsDirty();
    }} onMarksChange={/** 处理「onMarksChange」事件，校验归属后再推进状态且避免重复提交。 */
(variantId, next) => {
      setOutputMarks((current) => {
        const value = [...current.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(mark) => mark.variantId !== variantId), ...next];
        setCompleted((status) => ({ ...status, output: true }));
        return value;
      });
      markAnnotationsDirty();
    }} />}
    {tab === "execution" && <Execution experiment={experiment} scorecard={scorecard} evaluations={runEvaluations} liveExecutions={liveExecutions} />}
    {tab === "summary" && <Summary experiment={experiment} scorecard={scorecard} />}
    {isAnnotationTab(tab) && worksheet && !experiment.legacy && <footer className="annotation-footer"><button className="regenerate" type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => { if (confirmRegenerate) void generateWorksheet(true); else { setConfirmRegenerate(true); setMessageText("重新生成会清除旧工作表及其注释/评分；回答与运行事实保持不变。请再次确认。"); } }}><RefreshCw size={10} />{confirmRegenerate ? "确认重新生成" : "重新生成评测材料"}</button>{confirmRegenerate && <button className="regenerate" type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => { setConfirmRegenerate(false); setMessageText(""); }}>取消</button>}<span>{messageText || notice || annotationSyncLabel(syncState)}</span></footer>}
    {(messageText || notice) && (tab === "answers" || tab === "execution" || tab === "summary") && <div className={`experiment-message${worksheetGeneration === "failed" && !worksheet ? " worksheet-generation-error" : ""}`}><span>{messageText || notice}</span>{worksheetGeneration === "failed" && !worksheet && <button type="button" onClick={() => void generateWorksheet()}>重试生成题目</button>}</div>}
  </div>;
}

/** 渲染「LaneGrid」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function LaneGrid({ experiment, scorecard, contextDisclosure = false, interventions = {}, onIntervention, showInterventions = false, showRuntimeHeader = false, headerScore, children }: {
  experiment: EvalExperiment;
  scorecard?: ExperimentScorecard | null;
  contextDisclosure?: boolean;
  interventions?: Record<string, ExperimentIntervention[]>;
  onIntervention?: (testId: string, interventionId: string, content?: string | Record<string, unknown>) => void | Promise<void>;
  showInterventions?: boolean;
  showRuntimeHeader?: boolean;
  headerScore?: (run: EvalRun) => number | string;
  children: (run: EvalRun) => React.ReactNode;
}) { return <section className={`lane-grid lanes-${experiment.runs.length}`}>{experiment.runs.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(run) => { const variant = experiment.variants.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.variantId === run.variantId)!; const score = scorecard?.variants.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.variantId === run.variantId); const intervention = interventions[run.variantId]?.[0]; return <article key={run.variantId}>{contextDisclosure
  ? <ExperimentLaneContext configuration={variant.contextConfiguration ?? { status: "旧记录没有完整上下文配置" }} label={variant.label} status={run.status} subtitle={variant.subtitle} />
  : <header><span>{variant.label}</span><div><strong>Test {variant.label}</strong><small>{variant.subtitle}</small></div>{headerScore ? <span className="lane-header-score"><b>{headerScore(run)}</b><small>/ 100</small></span> : <em>{run.status}</em>}</header>}{showInterventions && intervention && onIntervention && <LaneIntervention testId={run.variantId} intervention={intervention} onRespond={onIntervention} />}{showRuntimeHeader && <><LaneModelFacts variant={variant} /><div className="lane-score-strip"><span>理解 {score?.dimensionScores.understanding ?? "—"}</span><span>规划 {score?.dimensionScores.planning ?? "—"}</span><span>输出 {score?.dimensionScores.output ?? "—"}</span><span>执行 {score?.dimensionScores.execution ?? "—"}</span></div></>}{children(run)}</article>; })}</section>; }

/** 渲染「LaneIntervention」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function LaneIntervention({ testId, intervention, onRespond }: { testId: string; intervention?: ExperimentIntervention; onRespond?: (testId: string, interventionId: string, content?: string | Record<string, unknown>) => void | Promise<void> }) {
  const [form, setForm] = useState<Record<string, unknown>>({});
  useEffect(/** 同步组件生命周期内的外部状态，并在清理阶段释放订阅或临时资源。 */
() => setForm({}), [intervention?.interventionId]);
  if (!intervention || !onRespond) return null;
  if (intervention.kind === "permission") return <section className="lane-intervention"><header><strong>需要授权 · {intervention.title}</strong><small>只影响当前 Test；选择会记录到运行事实。</small></header>{intervention.detail && <pre>{intervention.detail}</pre>}<footer>{intervention.options.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(option) => <button key={option.optionId} type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => onRespond(testId, intervention.interventionId, option.optionId)}>{option.name}</button>)}<button className="cancel" type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => onRespond(testId, intervention.interventionId)}>取消</button></footer></section>;
  return <section className="lane-intervention"><header><strong>{intervention.title}</strong><small>{intervention.message}</small></header><div className="lane-elicitation-fields">{intervention.fields.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(field) => <label key={field.name}><span>{field.label}{field.required ? " *" : ""}</span>{field.enumValues ? <select value={String(form[field.name] ?? "")} onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(event) => setForm({ ...form, [field.name]: event.target.value })}><option value="">请选择</option>{field.enumValues.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(value) => <option key={String(value)} value={String(value)}>{String(value)}</option>)}</select> : field.type === "boolean" ? <input checked={form[field.name] === true} type="checkbox" onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(event) => setForm({ ...form, [field.name]: event.target.checked })} /> : <input type={field.type === "number" ? "number" : "text"} value={String(form[field.name] ?? "")} onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(event) => setForm({ ...form, [field.name]: field.type === "number" ? Number(event.target.value) : event.target.value })} />}{field.description && <small>{field.description}</small>}</label>)}</div><footer><button disabled={!elicitationComplete(intervention, form)} type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => onRespond(testId, intervention.interventionId, form)}>提交回答</button><button className="cancel" type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => onRespond(testId, intervention.interventionId)}>取消</button></footer></section>;
}

/** 渲染「LaneModelFacts」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function LaneModelFacts({ variant }: { variant: EvalVariant }) { return <section className="lane-model-facts"><header><strong>模型与推理（已冻结）</strong><small>来自 prepare-run Test 快照</small></header>{variant.model ? <><span><b>{variant.model.display}</b><small>{variant.model.provider}</small></span><span><b>{variant.reasoning?.requested} → {variant.reasoning?.resolved}</b><small>{variant.reasoning?.native}</small></span></> : <p>旧记录只保存实验级模型，按原始语义展示。</p>}</section>; }

/** 渲染「WorksheetGate」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function WorksheetGate({ ready, message, onGenerate }: { ready: boolean; message: string; onGenerate: () => void }) { return <section className="worksheet-gate"><Braces size={20} /><h2>生成三维人工评测材料</h2><p>服务端使用实验配置中的“大聪明”，仅从用户 Prompt 与各 Test 首次思考整理理解候选项，并另外整理只读 Workflow 和最多五个回答大段，不给 verdict 或分数。</p>{message && <small>{message}</small>}<button disabled={!ready} type="button" onClick={onGenerate}>生成评测材料</button></section>; }

/** 理解能力只选择一次真实需求；各 Test 的覆盖关系来自工作表中的事实映射。 */
function Understanding({ experiment, worksheet, marks, requirements, selectedRequirementIds, hasOtherRequirement, listedRequirementsWeight, onToggle, onOtherRequirementToggle, onWeightChange }: {
  experiment: EvalExperiment;
  worksheet: ExperimentAnnotationWorksheet;
  marks: UnderstandingAnnotationFacts["marks"];
  requirements: UnderstandingAnnotationFacts["requirements"];
  selectedRequirementIds: string[];
  hasOtherRequirement: boolean;
  listedRequirementsWeight: number;
  onToggle: (requirementId: string) => void;
  onOtherRequirementToggle: () => void;
  onWeightChange: (value: number) => void;
}) {
  const missingMappings = worksheet.requirements.filter((requirement) => !requirementMappingReady(requirement, experiment, marks));
  return <section className="annotation-panel understanding-panel"><div className="understanding-workspace"><PanelHeading icon={<BrainCircuit size={16} />} title="需求理解能力 打分" detail={`只合并用户 Prompt 与各 Test 首次思考中的候选需求，只需人工选择一次 · ${worksheetGeneratorLabel(worksheet)}`} />
    {missingMappings.length > 0 && <div className="worksheet-compat-note">这份工作表由旧版整理器生成，缺少 Test 覆盖映射。请先使用底部“重新生成评测材料”，回答与 Runtime 事实不会重跑。</div>}
    <RequirementSelector
      hasOtherRequirement={hasOtherRequirement}
      listedRequirementsWeight={listedRequirementsWeight}
      onOtherRequirementToggle={onOtherRequirementToggle}
      onToggle={onToggle}
      onWeightChange={onWeightChange}
      requirements={worksheet.requirements.map((requirement) => {
        const ready = requirementMappingReady(requirement, experiment, marks);
        return { id: requirement.requirementId, label: requirement.label, sources: requirementSources(requirement, experiment).split(" · "), disabled: !ready, disabledTitle: "重新生成评测材料后可标注" };
      })}
      selectedIds={selectedRequirementIds}
      weightMax={99}
      weightMin={1}
    />
    <div className="mapping-heading"><span>TEST REQUIREMENT MAPPING</span><strong>首次思考识别对比</strong><p>候选需求选中后，工作表只按各 Test 的首次思考映射是否明确识别。</p></div>
    <LaneGrid experiment={experiment} headerScore={(run) => understandingScore(run.variantId, requirements, marks)}>{(run) => <div className="agent-understanding-list">
      {requirements.length === 0 && <p className="empty-annotation">请先从上方选择真实需求</p>}
      {requirements.map((requirement) => {
        const met = marks.find((mark) => mark.variantId === run.variantId && mark.requirementId === requirement.requirementId)?.verdict === "met";
        return <div className={met ? "matched" : ""} key={requirement.requirementId}><span>{met ? <Check size={10} /> : <X size={10} />}</span><p>{requirement.label}</p></div>;
      })}
    </div>}</LaneGrid></div>
  </section>;
}

/** Workflow 只读展示模型输出中可观察的规划；评分完全由人工滑块给出。 */
function Planning({ experiment, worksheet, scores, onScoreChange }: {
  experiment: EvalExperiment;
  worksheet: ExperimentAnnotationWorksheet;
  scores: PlanningAnnotationFacts["scores"];
  onScoreChange: (variantId: string, score: number) => void;
}) {
  return <section className="annotation-panel"><PanelHeading icon={<Route size={16} />} title="Workflow 规划能力评分" detail={`Workflow 仅展示模型输出中提取出的宏观规划；拖动滑块进行 0–100 分人工主观评分 · ${worksheetGeneratorLabel(worksheet)}`} />
    <LaneGrid experiment={experiment} headerScore={(run) => scores.find((item) => item.variantId === run.variantId)?.score ?? "—"}>{(run) => {
      const steps = worksheet.workflows.find((item) => item.variantId === run.variantId)?.steps ?? [];
      const score = scores.find((item) => item.variantId === run.variantId)?.score;
      return <WorkflowPlanningScore onChange={(value) => onScoreChange(run.variantId, value)} score={score} steps={steps} variantId={run.variantId} />;
    }}</LaneGrid>
  </section>;
}

/** 输出能力保留模型语义分段，但 verdict 由用户在段内拖选任意文字产生。 */
function Output({ answers, artifactScores, artifacts, experiment, worksheet, marks, onArtifactScoreChange, onMarksChange }: {
  answers: Record<string, string>;
  artifactScores: NonNullable<OutputAnnotationFacts["artifactScores"]>;
  artifacts: Record<string, OutputArtifactRef[]>;
  experiment: EvalExperiment;
  worksheet: ExperimentAnnotationWorksheet;
  marks: OutputAnnotationFacts["marks"];
  onArtifactScoreChange: (variantId: string, score: number) => void;
  onMarksChange: (variantId: string, marks: OutputAnnotationFacts["marks"]) => void;
}) {
  return <section className="annotation-panel"><PanelHeading icon={<Highlighter size={16} />} title="最终有效输出结果 标注" detail={`无产物时标注回答文字；有产物时仅查看产物链接并按 0–100 分评分 · ${worksheetGeneratorLabel(worksheet)}`} />
    <LaneGrid experiment={experiment} headerScore={(run) => {
      const linked = artifacts[run.variantId] ?? [];
      return linked.length > 0
        ? artifactScores.find((item) => item.variantId === run.variantId)?.score ?? 0
        : outputScore(answers[run.variantId] ?? "", marks.filter((item) => item.variantId === run.variantId));
    }}>{(run) => {
      const linked = artifacts[run.variantId] ?? [];
      if (linked.length > 0) return <ArtifactOutputScore
        artifacts={linked}
        score={artifactScores.find((item) => item.variantId === run.variantId)?.score ?? 0}
        variantId={run.variantId}
        onChange={(score) => onArtifactScoreChange(run.variantId, score)}
      />;
      const answer = answers[run.variantId] ?? "";
      const sections = (worksheet.outputSections.find((item) => item.variantId === run.variantId)?.sections ?? []).map((section) => ({
        answerSectionId: section.answerSectionId,
        label: section.label,
        start: section.start,
        end: section.end,
        text: answer.slice(section.start, section.end),
      }));
      return <OutputTextMarker variantId={run.variantId} sections={sections} marks={marks.filter((item) => item.variantId === run.variantId)} onChange={(next) => onMarksChange(run.variantId, next)} />;
    }}</LaneGrid>
  </section>;
}

/** 运行时先显示 ACP 临时轨迹，终态到达后仍由 Evaluation Trace 作为最终事实。 */
function Execution({ experiment, scorecard, evaluations, liveExecutions }: {
  experiment: EvalExperiment;
  scorecard: ExperimentScorecard | null;
  evaluations: Record<string, TurnEvaluationRecord | null>;
  liveExecutions: Record<string, LiveExecutionState>;
}) {
  const calculated = calculateExecutionScores(experiment.runs.flatMap((run) => run.executionMetrics ? [run.executionMetrics] : []));
  const now = useLiveClock(Object.values(liveExecutions).some((state) => state.completedAt === undefined));
  const executionFor = (run: EvalRun) => {
    const evaluation = evaluations[run.variantId];
    if (evaluation) return toDemoExecution(run, evaluation);
    const live = liveExecutions[run.variantId];
    return live ? toLiveDemoExecution(live, now) : toDemoExecution(run, null);
  };
  return <section className="annotation-panel"><PanelHeading icon={<ShieldCheck size={16} />} title="执行能力" detail="Runtime 摘要与执行轨迹集中展示，包括每次模型调用（含自动重试）、工具执行、错误状态和节点耗时。" /><LaneGrid
    experiment={experiment}
    headerScore={(run) => scorecard?.variants.find((item) => item.variantId === run.variantId)?.dimensionScores.execution ?? calculated.find((item) => item.variantId === run.variantId)?.score ?? "—"}
  >{(run) => <><ExecutionTrace execution={executionFor(run)} /><RunFacts run={run} /></>}</LaneGrid></section>;
}

/** 仅在存在临时执行轨迹时刷新进行中节点的耗时。 */
function useLiveClock(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}
/** 渲染「RunFacts」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function RunFacts({ run }: { run: EvalRun }) {
  const facts = run.runtimeFacts;
  if (!facts) return null;
  return <details className="run-facts"><summary><Braces size={11} />本 Test 的真实运行上下文</summary><div className="run-facts-summary">{facts.agentSnapshotHash && <span>Agent snapshot <code>{facts.agentSnapshotHash.slice(0, 12)}</code></span>}<span>{facts.capabilityGenerations} 个能力 generation · {facts.capabilityToolNames.length} tools</span><span>{facts.modelRounds?.length ?? 0} 个真实模型轮次</span>{facts.usage && <span>Usage input {facts.usage.inputTokens ?? "—"} / output {facts.usage.outputTokens ?? "—"}</span>}{facts.stopReason && <span>Stop reason {facts.stopReason}</span>}{run.hadHumanIntervention && <span>含人工介入</span>}</div>{facts.modelRounds?.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(round) => <details className="model-round-facts" key={round.roundIndex}><summary>模型轮次 {round.roundIndex + 1} · capability generation {round.capabilityGeneration}</summary><div className="model-round-sources">{round.contextSummary.items.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => <span key={item.id}><b>{item.title}</b><small>{item.kind} · 约 {item.estimatedTokens} tokens</small></span>)}</div>{round.resolvedReasoning && <p>推理：{round.resolvedReasoning.requestedProfile} → {round.resolvedReasoning.resolvedProfile} · {JSON.stringify(round.resolvedReasoning.native)}</p>}{round.providerInput && <details className="provider-input-facts"><summary>完整 Provider Input · {round.providerInputBytes ?? "—"} bytes · <code>{round.providerInputHash?.slice(0, 12)}</code></summary><pre>{round.providerInput.value}</pre></details>}</details>)}</details>;
}
/** 渲染「Summary」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function Summary({ experiment, scorecard }: { experiment: EvalExperiment; scorecard: ExperimentScorecard | null }) {
  if (!scorecard) return <Center title="四维评分尚未开始" detail="第一次人工标注后，理解、规划、输出与执行分会实时同步到这里。" />;
  const live = scorecard.variants.map((variant) => ({
    variantId: variant.variantId,
    totalScore: liveTotalScore(variant.dimensionScores),
  })).toSorted((left, right) => right.totalScore - left.totalScore);
  return <section className="summary-grid"><div className="radar-card"><header><BarChart3 size={16} /><div><strong>四维雷达图</strong><small>实时同步 · 理解、规划、输出、执行各占 25%</small></div></header><Radar scorecard={scorecard} experiment={experiment} /></div><div className="score-ledger"><header><strong>{scorecard.status === "complete" ? "排名" : "实时总分"}</strong><small>{scorecard.status === "complete" ? (scorecard.winnerVariantIds?.length && scorecard.winnerVariantIds.length > 1 ? "并列 winner" : "winner") : "未完成维度按 0 分显示"}</small></header>{(scorecard.ranking ?? live.map((row, index) => ({ rank: index + 1, variantIds: [row.variantId], totalScore: row.totalScore }))).map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
  (row) => <article key={`${row.rank}:${row.totalScore}`}><b>#{row.rank}</b><span>{row.variantIds.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
  (id) => experiment.variants.find(/** 按当前业务条件筛选或判断元素，不修改输入。 */
  (item) => item.variantId === id)?.label ?? id).join(" / ")}</span><strong>{row.totalScore}</strong></article>)}</div></section>;
}
/** 渲染「Radar」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function Radar({ scorecard, experiment }: { scorecard: ExperimentScorecard; experiment: EvalExperiment }) { const center = 120; const radius = 86; const axes = ["understanding", "planning", "output", "execution"] as const; const labels = ["理解", "规划", "输出", "执行"]; /** 执行「point」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function point(index: number, value: number) { const angle = -Math.PI / 2 + index * Math.PI / 2; return `${center + Math.cos(angle) * radius * value / 100},${center + Math.sin(angle) * radius * value / 100}`; } return <svg aria-label="四维评分雷达图" viewBox="0 0 240 240">{[.25,.5,.75,1].map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(scale) => <polygon className="radar-grid" key={scale} points={axes.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(_, i) => point(i, scale * 100)).join(" ")} />)}{scorecard.variants.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(variant, index) => <polygon className={`radar-series series-${index}`} key={variant.variantId} points={axes.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(axis, i) => point(i, variant.dimensionScores[axis] ?? 0)).join(" ")} />)}{labels.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(label, index) => { const [x,y] = point(index, 118).split(","); return <text key={label} x={x} y={y}>{label}</text>; })}<g className="radar-legend">{scorecard.variants.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(variant, index) => <text key={variant.variantId} x="12" y={212 + index * 12}>{experiment.variants.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.variantId === variant.variantId)?.label} · {variant.totalScore ?? liveTotalScore(variant.dimensionScores)}</text>)}</g></svg>; }

function liveTotalScore(scores: ExperimentScorecard["variants"][number]["dimensionScores"]): number {
  return Math.round(((scores.understanding ?? 0) + (scores.planning ?? 0) + (scores.output ?? 0) + (scores.execution ?? 0)) / 4);
}

/** 各 Tab 复用统一标题结构，避免内容区重新发明视觉层级。 */
function PanelHeading({ icon, title, detail }: { icon: React.ReactNode; title: string; detail: string }) {
  return <SectionHeading detail={detail} icon={icon} title={title} />;
}

const experimentArtifactNavigation = {
  href: (artifactId: string) => `/artifacts/${encodeURIComponent(artifactId)}`,
};

/** 原始回答不再有实验专用消息 UI，只为共用聊天消息流传入产物导航环境。 */
function ExperimentMessageFlow({ history: historyCollection, live, run }: {
  history: EntryCollection;
  live: EntryCollection;
  run: EvalRun;
}) {
  const fallback = historyCollection.order.length === 0 && live.order.length === 0
    ? fallbackAnswerCollection(run)
    : emptyEntries();
  const hasAnswer = [historyCollection, live, fallback].some((collection) => assistantText(collection).trim().length > 0);
  return <div className="chat-content experiment-chat-content">
    <ChatBlockList artifactNavigation={experimentArtifactNavigation} collection={historyCollection} />
    <ChatBlockList artifactNavigation={experimentArtifactNavigation} collection={live} />
    <ChatBlockList artifactNavigation={experimentArtifactNavigation} collection={fallback} />
    {!hasAnswer && <div className="comparison-stream-empty"><strong>{emptyAnswerState(run)}</strong><small>已保留结束前写入 Session 的真实消息和活动。</small></div>}
  </div>;
}

function fallbackAnswerCollection(run: EvalRun): EntryCollection {
  const text = run.answerTexts.join("\n");
  if (!text.trim()) return emptyEntries();
  const id = `message:fallback:${run.variantId}`;
  return {
    order: [id],
    byId: {
      [id]: {
        type: "message",
        id,
        messageId: `fallback:${run.variantId}`,
        turnId: run.turnId ?? run.variantId,
        role: "assistant",
        content: [{ type: "text", text }],
        status: "done",
      },
    },
  };
}

function assistantText(collection: EntryCollection | undefined): string {
  if (!collection) return "";
  return collection.order.flatMap((id) => {
    const entry = collection.byId[id];
    if (entry?.type !== "message" || entry.role !== "assistant") return [];
    return entry.content.flatMap((item) => item.type === "text" ? [item.text] : []);
  }).join("\n");
}

function emptyAnswerState(run: EvalRun): string {
  if (run.status === "pending") return "等待运行";
  if (run.status === "running") return "正在生成最终回答";
  if (run.status === "cancelled") return "运行已取消，尚未产生最终回答";
  if (run.status === "interrupted") return "运行已中断，尚未产生最终回答";
  if (run.status === "failed") return run.error?.message ?? "运行失败，未产生最终回答";
  return "运行已结束，但没有产生最终回答";
}

function historyAnswer(entries: SessionHistoryEntry[]): string {
  return entries.flatMap((entry) => entry.type === "message" && entry.role === "assistant" ? [entry.text] : []).join("\n");
}

function requirementSources(requirement: ExperimentAnnotationWorksheet["requirements"][number], experiment: EvalExperiment): string {
  const sources = requirement.sourceVariantIds ?? [];
  if (sources.length === 0) return "旧版工作表来源未记录";
  return sources.map((id) => id === "task" ? "用户提示词" : `Test ${experiment.variants.find((item) => item.variantId === id)?.label ?? id}`).join(" · ");
}

function requirementMappingReady(requirement: ExperimentAnnotationWorksheet["requirements"][number], experiment: EvalExperiment, marks: UnderstandingAnnotationFacts["marks"]): boolean {
  return requirement.matchedVariantIds !== undefined || experiment.runs.every((run) => marks.some((mark) => mark.variantId === run.variantId && mark.requirementId === requirement.requirementId));
}

function understandingScore(variantId: string, requirements: UnderstandingAnnotationFacts["requirements"], marks: UnderstandingAnnotationFacts["marks"]): number {
  if (requirements.length === 0) return 0;
  const total = requirements.reduce((sum, item) => sum + item.weight, 0);
  const met = requirements.reduce((sum, item) => sum + (marks.find((mark) => mark.variantId === variantId && mark.requirementId === item.requirementId)?.verdict === "met" ? item.weight : 0), 0);
  return total <= 0 ? 0 : Math.round(100 * met / total);
}

function understandingRequirements(
  selected: ExperimentAnnotationWorksheet["requirements"],
  hasOther: boolean,
  listedWeight: number,
): UnderstandingAnnotationFacts["requirements"] {
  if (!hasOther) return selected.map((item) => ({ requirementId: item.requirementId, label: item.label, weight: item.weight }));
  const total = selected.reduce((sum, item) => sum + item.weight, 0);
  const listedShare = selected.length > 0 ? listedWeight : 0;
  return [
    ...selected.map((item) => ({ requirementId: item.requirementId, label: item.label, weight: total > 0 ? item.weight / total * listedShare : item.weight })),
    { requirementId: "manual-other", label: "其他需求", weight: 100 - listedShare },
  ];
}

function listedWeightFromScorecard(scorecard: ExperimentScorecard | null): number {
  const requirements = scorecard?.annotations.understanding.requirements ?? [];
  const total = requirements.reduce((sum, item) => sum + item.weight, 0);
  const other = requirements.find((item) => item.requirementId === "manual-other");
  if (!other || total <= 0) return 80;
  return Math.max(1, Math.min(99, Math.round(100 * (total - other.weight) / total)));
}

function outputScore(text: string, marks: OutputAnnotationFacts["marks"]): number {
  if (marks.length === 0) return 0;
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

/** 校验并规范化「normalizeExperiment」输入，非法数据直接返回明确错误。 */
function normalizeExperiment(raw: AnyExperimentRecord): EvalExperiment {
  if (raw.schemaVersion === 1) return {
    experimentId: raw.experimentId, name: raw.name, promptText: raw.promptText, status: raw.status,
    ...(raw.savedAt ? { savedAt: raw.savedAt } : {}), legacy: true,
    variants: raw.variants.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => ({ variantId: item.variantId, label: item.label, subtitle: item.mode === "reuse_snapshot" ? "旧版历史快照" : "旧版 Runtime", contextConfiguration: item })),
    runs: raw.runs.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(run) => ({ variantId: run.variantId, status: run.status, answerTexts: run.answerTexts, ...(run.acpSessionId ? { acpSessionId: run.acpSessionId } : {}), ...(run.turnId ? { turnId: run.turnId } : {}), ...(run.executionMetrics ? { executionMetrics: run.executionMetrics } : {}), ...(run.runtimeFacts ? { runtimeFacts: run.runtimeFacts } : {}), ...(run.error ? { error: run.error } : {}) })),
    ...(raw.annotationWorksheet ? { annotationWorksheet: raw.annotationWorksheet } : {}),
  };
  return {
    experimentId: raw.experimentId, name: raw.name, promptText: raw.promptText, status: raw.status,
    ...(raw.savedAt ? { savedAt: raw.savedAt } : {}), legacy: false,
    variants: raw.tests.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(test) => { const snapshot = raw.snapshots?.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.testId === test.testId); return {
      variantId: test.testId, label: test.label, subtitle: "全新 Session · 真实 Runtime",
      ...(snapshot ? { model: { display: snapshot.model.model, provider: snapshot.model.providerKind }, reasoning: { requested: snapshot.reasoning.requestedProfile, resolved: snapshot.reasoning.resolvedProfile, native: JSON.stringify(snapshot.reasoning.native) } } : {}),
      contextConfiguration: {
        sourceAgent: test.sourceAgent,
        modelStudentId: test.modelStudentId,
        reasoningProfile: test.reasoningProfile,
        policy: test.policy,
        ...(snapshot ? { frozenSnapshot: snapshot } : {}),
      },
    }; }),
    runs: raw.runs.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(run) => ({ variantId: run.testId, status: run.status, answerTexts: run.answerTexts, ...(run.acpSessionId ? { acpSessionId: run.acpSessionId } : {}), ...(run.turnId ? { turnId: run.turnId } : {}), ...(run.executionMetrics ? { executionMetrics: run.executionMetrics } : {}), ...(run.runtimeFacts ? { runtimeFacts: run.runtimeFacts } : {}), ...(run.error ? { error: run.error } : {}), ...(run.hadHumanIntervention ? { hadHumanIntervention: true } : {}) })),
    ...(raw.annotationWorksheet ? { annotationWorksheet: raw.annotationWorksheet } : {}),
  };
}
/** 执行「elicitationComplete」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function elicitationComplete(intervention: ElicitationIntervention, form: Record<string, unknown>): boolean { return intervention.fields.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.required).every(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => form[item.name] !== undefined && form[item.name] !== ""); }
/** 执行「worksheetGeneratorLabel」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function worksheetGeneratorLabel(worksheet: ExperimentAnnotationWorksheet) { const value = worksheet.generator; return `整理模型 ${value.modelStudentId} · ${value.providerKind} · ${value.model}`; }
/** 把自动同步状态投影为稳定文案，不再提供“保存并计算”动作。 */
function annotationSyncLabel(state: "idle" | "syncing" | "synced" | "error"): string {
  if (state === "syncing") return "正在实时同步注释与四维评分…";
  if (state === "synced") return "注释与四维评分已实时同步";
  if (state === "error") return "实时同步失败，请继续编辑或重试";
  return "人工标注会自动保存并实时更新四维评分";
}
/** 执行「terminalStatus」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function terminalStatus(status: string) { return ["completed", "partially_failed", "failed", "cancelled", "interrupted"].includes(status); }
/** 渲染「Center」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function Center({ title, detail, retry }: { title: string; detail: string; retry?: () => void }) { return <main className="centered-state"><div><Beaker size={20} /><h1>{title}</h1><p>{detail}</p>{retry && <button type="button" onClick={retry}>重试</button>}</div></main>; }
/** 执行「message」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function message(value: unknown) { return value instanceof Error ? value.message : String(value); }
