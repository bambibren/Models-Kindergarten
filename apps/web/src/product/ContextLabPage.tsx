import { Beaker, History, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  AgentRecord,
  ContextPreviewResponseV2,
  ExperimentDraftV2,
  McpInstallationView,
  ModelStudentSummary,
  ReasoningProfile,
  SkillInstallation,
} from "@kindergarten/contracts";
import { controlApi, type CapabilityOptions, type TurnContextSnapshot } from "../api/control-api.js";
import { formatContextWindow, joinMetadata } from "../components/tokens/token-format.js";
import { profileLabel, reasoningAutoLabel } from "../reasoning/reasoning-config.js";
import { AgentPolicyFields } from "./AgentPolicyFields.js";
import { ContextPreviewPanel } from "./ContextPreviewPanel.js";
import {
  addContextLane,
  importAgentIntoLane,
  initialContextLanes,
  policyFromAgent,
  removeContextLane,
  updateContextLane,
  type ContextLabLane,
} from "./context-lab-state.js";
import { ErrorState, LoadingState } from "./LoadState.js";
import { ProductNav } from "./ProductNav.js";
import { useResource } from "./use-resource.js";

interface PreviewState {
  fingerprint: string;
  loading: boolean;
  value?: ContextPreviewResponseV2;
  error?: string;
}

export function ContextLabPage() {
  const turnId = new URLSearchParams(location.search).get("turnId") ?? undefined;
  const load = useCallback(async () => {
    const [agents, models, options, skills, mcps, source] = await Promise.all([
      controlApi.agents(), controlApi.models(), controlApi.capabilityOptions(),
      controlApi.skills(), controlApi.mcps(),
      turnId ? controlApi.turnContext(turnId) : Promise.resolve(undefined),
    ]);
    return { agents: agents.items, models: models.items.filter((item) => item.status === "ready"), options, skills: skills.items, mcps, source };
  }, [turnId]);
  const { state, retry } = useResource(load);
  return <main className="product-page"><ProductNav active="context" />{
    state.phase === "loading" ? <LoadingState label={turnId ? "正在导入 Turn 配置" : "正在读取实验能力"} />
      : state.phase === "error" ? <ErrorState {...state} retry={retry} />
        : <ContextLabReady {...state.data} />
  }</main>;
}

function ContextLabReady({ agents, models, options, skills, mcps, source }: {
  agents: AgentRecord[];
  models: ModelStudentSummary[];
  options: CapabilityOptions;
  skills: SkillInstallation[];
  mcps: McpInstallationView[];
  source: TurnContextSnapshot | undefined;
}) {
  const initialAgent = agents.find((item) => item.agentId === source?.turn.agentId) ?? agents[0];
  if (!initialAgent) return <ErrorState message="请先创建一个 Agent，再配置上下文实验。" retry={() => { location.href = "/agents/new"; }} />;
  const initialModelId = models.some((item) => item.modelStudentId === source?.turn.modelStudentId)
    ? source!.turn.modelStudentId
    : models[0]?.modelStudentId ?? "";
  const initialPolicy = source?.sourcePolicy ?? policyFromAgent(initialAgent);
  const importedReasoning = source?.resolvedReasoning?.resolvedProfile ?? "auto";
  const [name, setName] = useState(source ? "来源 Turn 配置对照" : "上下文配置对照");
  const [prompt, setPrompt] = useState(source?.promptText ?? "");
  const [lanes, setLanes] = useState<ContextLabLane[]>(() => initialContextLanes(initialAgent, initialPolicy, initialModelId, importedReasoning));
  const [activeTestId, setActiveTestId] = useState(() => lanes[0]?.testId ?? "");
  const [worksheetModelStudentId, setWorksheetModelStudentId] = useState(initialModelId);
  const [toolExpected, setToolExpected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [previews, setPreviews] = useState<Record<string, PreviewState>>({});
  const activeLane = lanes.find((item) => item.testId === activeTestId) ?? lanes[0];
  const fingerprints = useMemo(() => Object.fromEntries(lanes.map((lane) => [lane.testId, fingerprint(prompt, lane)])), [lanes, prompt]);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      for (const lane of lanes) {
        const currentFingerprint = fingerprints[lane.testId]!;
        setPreviews((current) => ({ ...current, [lane.testId]: { fingerprint: currentFingerprint, loading: true } }));
        void previewLane(prompt, lane).then((value) => {
          if (!cancelled) setPreviews((current) => ({ ...current, [lane.testId]: { fingerprint: currentFingerprint, loading: false, value } }));
        }).catch((error: unknown) => {
          if (!cancelled) setPreviews((current) => ({ ...current, [lane.testId]: { fingerprint: currentFingerprint, loading: false, error: errorMessage(error) } }));
        });
      }
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [fingerprints, lanes, prompt]);

  function importAgent(agentId: string) {
    if (!activeLane) return;
    const agent = agents.find((item) => item.agentId === agentId);
    if (agent) setLanes((current) => importAgentIntoLane(current, activeLane.testId, agent));
  }

  function patchLane(change: Partial<Pick<ContextLabLane, "modelStudentId" | "reasoningProfile" | "policy">>) {
    if (activeLane) setLanes((current) => updateContextLane(current, activeLane.testId, change));
  }

  function changeModel(modelStudentId: string) {
    if (!activeLane) return;
    const model = models.find((item) => item.modelStudentId === modelStudentId);
    const supported = model?.supports.reasoning.supportedProfiles ?? [];
    const reset = activeLane.reasoningProfile !== "auto" && !supported.includes(activeLane.reasoningProfile);
    patchLane({ modelStudentId, ...(reset ? { reasoningProfile: "auto" } : {}) });
    if (reset) setMessage(`Test ${activeLane.label} 的原推理档位不受新模型支持，已重置为“自动”。`);
  }

  function addLane() {
    const next = addContextLane(lanes, activeTestId);
    setLanes(next);
    const added = next.find((item) => item.label === "C");
    if (added) setActiveTestId(added.testId);
  }

  function removeLane(testId: string) {
    const next = removeContextLane(lanes, testId);
    setLanes(next);
    if (activeTestId === testId) setActiveTestId(next.find((item) => item.label === "B")?.testId ?? next[0]?.testId ?? "");
  }

  async function refreshPreview() {
    if (!activeLane) return;
    const currentFingerprint = fingerprint(prompt, activeLane);
    setPreviews((current) => ({ ...current, [activeLane.testId]: { fingerprint: currentFingerprint, loading: true } }));
    try {
      const value = await previewLane(prompt, activeLane);
      setPreviews((current) => ({ ...current, [activeLane.testId]: { fingerprint: currentFingerprint, loading: false, value } }));
    } catch (error) {
      setPreviews((current) => ({ ...current, [activeLane.testId]: { fingerprint: currentFingerprint, loading: false, error: errorMessage(error) } }));
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      const input: ExperimentDraftV2 = {
        schemaVersion: 2, name, promptText: prompt,
        ...(source ? { sourceRef: { kind: "turn", id: source.turn.turnId } } : {}),
        toolUseWasExpected: toolExpected,
        worksheetModelStudentId,
        tests: lanes.map((lane) => ({
          testId: lane.testId, label: lane.label, sourceAgent: lane.sourceAgent,
          modelStudentId: lane.modelStudentId, reasoningProfile: lane.reasoningProfile, policy: lane.policy,
        })),
      };
      const experiment = await controlApi.createExperiment(input);
      await controlApi.prepareExperiment(experiment.experimentId, crypto.randomUUID());
      location.href = evaluationExperimentUrl(experiment.experimentId);
    } catch (error) { setMessage(errorMessage(error)); setBusy(false); }
  }

  const currentPreview = activeLane ? previews[activeLane.testId] : undefined;
  const currentFingerprint = activeLane ? fingerprints[activeLane.testId] : undefined;
  const visiblePreview = currentPreview?.fingerprint === currentFingerprint ? currentPreview : undefined;
  const previewValues = lanes.map((lane) => {
    const item = previews[lane.testId];
    return item && item.fingerprint === fingerprints[lane.testId] ? item.value : undefined;
  });
  const allRunnable = previewValues.length === lanes.length && previewValues.every((item) => item?.runnable);
  const distinct = new Set(previewValues.flatMap((item) => item ? [item.effectiveConfigurationHash] : [])).size >= 2;

  return <div className="product-context-shell">
    <header className="product-context-heading"><span>MODEL CONTEXT · EXPERIMENT V2</span><h1>模型上下文实验</h1><p>同一份用户提示词；每个 Test 独立配置 Agent、模型和推理级别，并在全新 Session 的首轮重新运行。</p></header>
    {source && <section className="product-source-snapshot"><History size={15} /><div><strong>已从 Turn 导入配置</strong><small>{source.turn.turnId} · 只导入提示词、Agent、模型和实际推理事实；不读取历史、不复用回答，提示词仍可编辑。</small></div></section>}
    <form onSubmit={(event) => void submit(event)}>
      <section className="product-context-prompt">
        <label><span>实验名称</span><input required value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label><span>公共用户提示词</span><textarea required rows={4} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="输入所有 Test 都要回答的问题…" /></label>
        <div><label><span>评测辅助模型</span><select value={worksheetModelStudentId} onChange={(event) => setWorksheetModelStudentId(event.target.value)}>{models.map(modelOption)}</select><small>只用于整理人工标注题目，不参与被测回答和自动评分。</small></label><label className="product-checkbox"><input checked={toolExpected} type="checkbox" onChange={(event) => setToolExpected(event.target.checked)} /><span>这个任务预期必须使用 Tool</span></label></div>
      </section>
      <section className="product-lanes">
        <header><div><strong>Test 配置</strong><small>A/B 初始一致；至少两个 Test 的实际运行配置需要不同</small></div><button disabled={lanes.length >= 3} type="button" onClick={addLane}><Plus size={13} />添加 C</button></header>
        <div className="product-context-workbench">
          <aside className="product-version-rail" aria-label="Test 配置">{lanes.map((lane) => {
            const preview = previews[lane.testId];
            const fresh = preview?.fingerprint === fingerprints[lane.testId] ? preview : undefined;
            return <button className={lane.testId === activeLane?.testId ? "active" : ""} key={lane.testId} type="button" onClick={() => setActiveTestId(lane.testId)}><b>{lane.label}</b><span><strong>Test {lane.label}</strong><small>{fresh?.loading ? "预检中" : fresh?.value?.runnable ? "可运行" : "待调整"}</small></span></button>;
          })}</aside>
          {activeLane && <div className="product-lane-editor">
            <header><div><span>{activeLane.label}</span><div><strong>Test {activeLane.label}</strong><small>临时配置，不会修改已保存 Agent</small></div></div>{activeLane.label === "C" && <button aria-label="删除 Test C" type="button" onClick={() => removeLane(activeLane.testId)}><Trash2 size={13} />删除 C</button>}</header>
            <label className="product-agent-import"><span>导入已保存 Agent</span><select value={activeLane.sourceAgent.agentId} onChange={(event) => importAgent(event.target.value)}>{agents.map((item) => <option key={item.agentId} value={item.agentId}>{item.name}</option>)}</select><small>只复制到当前 Test；模型和推理级别保持不变。</small></label>
            <LaneModelReasoning lane={activeLane} models={models} onModelChange={changeModel} onReasoningChange={(reasoningProfile) => patchLane({ reasoningProfile })} />
            <div className="product-policy-stack"><AgentPolicyFields builtinToolIds={options.builtinTools} mcps={mcps} onChange={(policy) => patchLane({ policy })} readOnly={false} showHistory={false} showMemory={false} skills={skills} value={activeLane.policy} /></div>
            <HistoryFact policy={activeLane.policy.historyPolicy} />
            <ContextPreviewPanel error={visiblePreview?.error} loading={visiblePreview?.loading} onRefresh={() => void refreshPreview()} value={visiblePreview?.value} />
          </div>}
        </div>
      </section>
      <footer className="product-context-runbar"><span>{message || (!allRunnable ? "等待全部 Test 通过预检。" : !distinct ? "至少两个 Test 的实际运行配置需要不同。" : "全部 Test 将创建新的实验 Session 并重新运行。")}</span><button disabled={busy || !prompt.trim() || lanes.length < 2 || !allRunnable || !distinct} type="submit"><Beaker size={15} />{busy ? "正在冻结实验" : "开始对比实验"}</button></footer>
    </form>
  </div>;
}

function LaneModelReasoning({ lane, models, onModelChange, onReasoningChange }: {
  lane: ContextLabLane;
  models: ModelStudentSummary[];
  onModelChange: (value: string) => void;
  onReasoningChange: (value: ReasoningProfile) => void;
}) {
  const model = models.find((item) => item.modelStudentId === lane.modelStudentId);
  const capability = model?.supports.reasoning;
  const choices: ReasoningProfile[] = capability?.adjustable ? ["auto", ...capability.supportedProfiles] : [];
  return <section className="product-lane-model"><header><strong>模型与推理</strong><small>每个 Test 独立选择；prepare-run 后冻结</small></header><label><span>ModelStudent</span><select value={lane.modelStudentId} onChange={(event) => onModelChange(event.target.value)}>{models.map(modelOption)}</select></label>{capability?.adjustable ? <label><span>推理级别</span><select value={lane.reasoningProfile} onChange={(event) => onReasoningChange(event.target.value as ReasoningProfile)}>{choices.map((choice) => <option key={choice} value={choice}>{choice === "auto" ? reasoningAutoLabel(capability) : profileLabel(choice, capability)}</option>)}</select></label> : <p className="product-readonly-fact">推理级别：固定 · {capability ? profileLabel(capability.defaultProfile, capability) : "未知"}</p>}</section>;
}

function HistoryFact({ policy }: { policy: ContextLabLane["policy"]["historyPolicy"] }) {
  return <section className="product-history-fact"><History size={15} /><div><strong>{policy.mode === "recent_turns" ? `Agent 历史策略：最近 ${policy.maxTurns} 个完整 Turn（只读）` : "Agent 历史策略：不带历史（只读）"}</strong><small>本次每个 Test 使用全新实验 Session，只运行首轮，实际进入历史为 0；此项仅帮助理解 Agent 配置，不影响本次实验结果。</small></div></section>;
}

function modelOption(model: ModelStudentSummary) {
  return <option key={model.modelStudentId} value={model.modelStudentId}>{joinMetadata([model.displayName, formatContextWindow(model.contextWindowTokens), model.model])}</option>;
}
function fingerprint(prompt: string, lane: ContextLabLane): string { return JSON.stringify({ prompt, lane }); }
function previewLane(promptText: string, lane: ContextLabLane) {
  return controlApi.contextPreview({ schemaVersion: 2, promptText, test: {
    testId: lane.testId, label: lane.label, sourceAgent: lane.sourceAgent,
    modelStudentId: lane.modelStudentId, reasoningProfile: lane.reasoningProfile, policy: lane.policy,
  } });
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function evaluationExperimentUrl(id: string): string { return new URL(`/evaluation/experiments/${encodeURIComponent(id)}`, import.meta.env.VITE_EVALUATION_WEB_URL ?? "http://127.0.0.1:5175").toString(); }
