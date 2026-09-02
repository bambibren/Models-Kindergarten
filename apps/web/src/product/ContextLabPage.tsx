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

/** 渲染「ContextLabPage」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function ContextLabPage() {
  const turnId = new URLSearchParams(location.search).get("turnId") ?? undefined;
  const load = useCallback(/** 缓存「load」的派生计算，依赖变化时重新生成以避免陈旧闭包。 */
async () => {
    const [agents, models, options, skills, mcps, source] = await Promise.all([
      controlApi.agents(), controlApi.models(), controlApi.capabilityOptions(),
      controlApi.skills(), controlApi.mcps(),
      turnId ? controlApi.turnContext(turnId) : Promise.resolve(undefined),
    ]);
    return { agents: agents.items, models: models.items.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.status === "ready"), options, skills: skills.items, mcps, source };
  }, [turnId]);
  const { state, retry } = useResource(load);
  return <main className="product-page"><ProductNav active="context" />{
    state.phase === "loading" ? <LoadingState label={turnId ? "正在导入 Turn 配置" : "正在读取实验能力"} />
      : state.phase === "error" ? <ErrorState {...state} retry={retry} />
        : <ContextLabReady {...state.data} />
  }</main>;
}

/** 渲染「ContextLabReady」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function ContextLabReady({ agents, models, options, skills, mcps, source }: {
  agents: AgentRecord[];
  models: ModelStudentSummary[];
  options: CapabilityOptions;
  skills: SkillInstallation[];
  mcps: McpInstallationView[];
  source: TurnContextSnapshot | undefined;
}) {
  const initialAgent = agents.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.agentId === source?.turn.agentId) ?? agents[0];
  if (!initialAgent) return <ErrorState message="请先创建一个 Agent，再配置上下文实验。" retry={/** 执行「retry」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => { location.href = "/agents/new"; }} />;
  const initialModelId = models.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.modelStudentId === source?.turn.modelStudentId)
    ? source!.turn.modelStudentId
    : models[0]?.modelStudentId ?? "";
  const initialPolicy = source?.sourcePolicy ?? policyFromAgent(initialAgent);
  const importedReasoning = source?.resolvedReasoning?.resolvedProfile ?? "auto";
  const [name, setName] = useState(source ? "来源 Turn 配置对照" : "上下文配置对照");
  const [prompt, setPrompt] = useState(source?.promptText ?? "");
  const [lanes, setLanes] = useState<ContextLabLane[]>(/** 执行「[lanes, setLanes]」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => initialContextLanes(initialAgent, initialPolicy, initialModelId, importedReasoning));
  const [activeTestId, setActiveTestId] = useState(/** 执行「[activeTestId, setActiveTestId]」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => lanes[0]?.testId ?? "");
  const [toolExpected, setToolExpected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [previews, setPreviews] = useState<Record<string, PreviewState>>({});
  const activeLane = lanes.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.testId === activeTestId) ?? lanes[0];
  const fingerprints = useMemo(/** 缓存「fingerprints」的派生计算，依赖变化时重新生成以避免陈旧闭包。 */
() => Object.fromEntries(lanes.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(lane) => [lane.testId, fingerprint(prompt, lane)])), [lanes, prompt]);

  useEffect(/** 同步组件生命周期内的外部状态，并在清理阶段释放订阅或临时资源。 */
() => {
    let cancelled = false;
    const timer = window.setTimeout(/** 执行受生命周期约束的定时任务，调用方负责在结束时取消句柄。 */
() => {
      for (const lane of lanes) {
        const currentFingerprint = fingerprints[lane.testId]!;
        setPreviews(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(current) => ({ ...current, [lane.testId]: { fingerprint: currentFingerprint, loading: true } }));
        void previewLane(prompt, lane).then(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
(value) => {
          if (!cancelled) setPreviews(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(current) => ({ ...current, [lane.testId]: { fingerprint: currentFingerprint, loading: false, value } }));
        }).catch(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
(error: unknown) => {
          if (!cancelled) setPreviews(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(current) => ({ ...current, [lane.testId]: { fingerprint: currentFingerprint, loading: false, error: errorMessage(error) } }));
        });
      }
    }, 250);
    return /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */ () => { cancelled = true; window.clearTimeout(timer); };
  }, [fingerprints, lanes, prompt]);

  /** 执行「importAgent」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function importAgent(agentId: string) {
    if (!activeLane) return;
    const agent = agents.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.agentId === agentId);
    if (agent) setLanes(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(current) => importAgentIntoLane(current, activeLane.testId, agent));
  }

  /** 执行「patchLane」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function patchLane(change: Partial<Pick<ContextLabLane, "modelStudentId" | "reasoningProfile" | "policy">>) {
    if (activeLane) setLanes(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(current) => updateContextLane(current, activeLane.testId, change));
  }

  /** 执行「changeModel」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function changeModel(modelStudentId: string) {
    if (!activeLane) return;
    const model = models.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.modelStudentId === modelStudentId);
    const supported = model?.supports.reasoning.supportedProfiles ?? [];
    const reset = activeLane.reasoningProfile !== "auto" && !supported.includes(activeLane.reasoningProfile);
    patchLane({ modelStudentId, ...(reset ? { reasoningProfile: "auto" } : {}) });
    if (reset) setMessage(`Test ${activeLane.label} 的原推理档位不受新模型支持，已重置为“自动”。`);
  }

  /** 执行「addLane」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function addLane() {
    const next = addContextLane(lanes, activeTestId);
    setLanes(next);
    const added = next.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.label === "C");
    if (added) setActiveTestId(added.testId);
  }

  /** 释放或删除「removeLane」对应资源，重复调用仍保持安全。 */
function removeLane(testId: string) {
    const next = removeContextLane(lanes, testId);
    setLanes(next);
    if (activeTestId === testId) setActiveTestId(next.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.label === "B")?.testId ?? next[0]?.testId ?? "");
  }

  /** 执行「refreshPreview」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async function refreshPreview() {
    if (!activeLane) return;
    const currentFingerprint = fingerprint(prompt, activeLane);
    setPreviews(/** 执行「refreshPreview」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(current) => ({ ...current, [activeLane.testId]: { fingerprint: currentFingerprint, loading: true } }));
    try {
      const value = await previewLane(prompt, activeLane);
      setPreviews(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(current) => ({ ...current, [activeLane.testId]: { fingerprint: currentFingerprint, loading: false, value } }));
    } catch (error) {
      setPreviews(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(current) => ({ ...current, [activeLane.testId]: { fingerprint: currentFingerprint, loading: false, error: errorMessage(error) } }));
    }
  }

  /** 执行「submit」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      const input: ExperimentDraftV2 = {
        schemaVersion: 2, name, promptText: prompt,
        ...(source ? { sourceRef: { kind: "turn", id: source.turn.turnId } } : {}),
        toolUseWasExpected: toolExpected,
        tests: lanes.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(lane) => ({
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
  const previewValues = lanes.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(lane) => {
    const item = previews[lane.testId];
    return item && item.fingerprint === fingerprints[lane.testId] ? item.value : undefined;
  });
  const allRunnable = previewValues.length === lanes.length && previewValues.every(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item?.runnable);
  const distinct = new Set(previewValues.flatMap(/** 执行「size」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(item) => item ? [item.effectiveConfigurationHash] : [])).size >= 2;

  return <div className="product-context-shell">
    <header className="product-context-heading"><span>MODEL CONTEXT · EXPERIMENT V2</span><h1>模型上下文实验</h1><p>同一份用户提示词；每个 Test 独立配置 Agent、模型和推理级别，并在全新 Session 的首轮重新运行。</p></header>
    {source && <section className="product-source-snapshot"><History size={15} /><div><strong>已从 Turn 导入配置</strong><small>{source.turn.turnId} · 只导入提示词、Agent、模型和实际推理事实；不读取历史、不复用回答，提示词仍可编辑。</small></div></section>}
    <form onSubmit={/** 处理「onSubmit」事件，校验归属后再推进状态且避免重复提交。 */
(event) => void submit(event)}>
      <section className="product-context-prompt">
        <label><span>实验名称</span><input required value={name} onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(event) => setName(event.target.value)} /></label>
        <label><span>公共用户提示词</span><textarea required rows={4} value={prompt} onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(event) => setPrompt(event.target.value)} placeholder="输入所有 Test 都要回答的问题…" /></label>
        <div><label className="product-checkbox"><input checked={toolExpected} type="checkbox" onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(event) => setToolExpected(event.target.checked)} /><span>这个任务预期必须使用 Tool</span></label></div>
      </section>
      <section className="product-lanes">
        <header><div><strong>Test 配置</strong><small>A/B 初始一致；至少两个 Test 的实际运行配置需要不同</small></div><button disabled={lanes.length >= 3} type="button" onClick={addLane}><Plus size={13} />添加 C</button></header>
        <div className="product-context-workbench">
          <aside className="product-version-rail" aria-label="Test 配置">{lanes.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(lane) => {
            const preview = previews[lane.testId];
            const fresh = preview?.fingerprint === fingerprints[lane.testId] ? preview : undefined;
            return <button className={lane.testId === activeLane?.testId ? "active" : ""} key={lane.testId} type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => setActiveTestId(lane.testId)}><b>{lane.label}</b><span><strong>Test {lane.label}</strong><small>{fresh?.loading ? "预检中" : fresh?.value?.runnable ? "可运行" : "待调整"}</small></span></button>;
          })}</aside>
          {activeLane && <div className="product-lane-editor">
            <header><div><span>{activeLane.label}</span><div><strong>Test {activeLane.label}</strong><small>临时配置，不会修改已保存 Agent</small></div></div>{activeLane.label === "C" && <button aria-label="删除 Test C" type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => removeLane(activeLane.testId)}><Trash2 size={13} />删除 C</button>}</header>
            <label className="product-agent-import"><span>导入已保存 Agent</span><select value={activeLane.sourceAgent.agentId} onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(event) => importAgent(event.target.value)}>{agents.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => <option key={item.agentId} value={item.agentId}>{item.name}</option>)}</select><small>只复制到当前 Test；模型和推理级别保持不变。</small></label>
            <LaneModelReasoning lane={activeLane} models={models} onModelChange={changeModel} onReasoningChange={/** 处理「onReasoningChange」事件，校验归属后再推进状态且避免重复提交。 */
(reasoningProfile) => patchLane({ reasoningProfile })} />
            <div className="product-policy-stack"><AgentPolicyFields builtinSkills={options.builtinSkills} builtinToolIds={options.builtinTools} mcps={mcps} onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(policy) => patchLane({ policy })} readOnly={false} showHistory={false} showMemory={false} skills={skills} value={activeLane.policy} /></div>
            <HistoryFact policy={activeLane.policy.historyPolicy} />
            <ContextPreviewPanel error={visiblePreview?.error} loading={visiblePreview?.loading} onRefresh={/** 处理「onRefresh」事件，校验归属后再推进状态且避免重复提交。 */
() => void refreshPreview()} value={visiblePreview?.value} />
          </div>}
        </div>
      </section>
      <footer className="product-context-runbar"><span>{message || (!allRunnable ? "等待全部 Test 通过预检。" : !distinct ? "至少两个 Test 的实际运行配置需要不同。" : "全部 Test 将创建新的实验 Session 并重新运行。")}</span><button disabled={busy || !prompt.trim() || lanes.length < 2 || !allRunnable || !distinct} type="submit"><Beaker size={15} />{busy ? "正在冻结实验" : "开始对比实验"}</button></footer>
    </form>
  </div>;
}

/** 渲染「LaneModelReasoning」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function LaneModelReasoning({ lane, models, onModelChange, onReasoningChange }: {
  lane: ContextLabLane;
  models: ModelStudentSummary[];
  onModelChange: (value: string) => void;
  onReasoningChange: (value: ReasoningProfile) => void;
}) {
  const model = models.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.modelStudentId === lane.modelStudentId);
  const capability = model?.supports.reasoning;
  const choices: ReasoningProfile[] = capability?.adjustable ? ["auto", ...capability.supportedProfiles] : [];
  return <section className="product-lane-model"><header><strong>模型与推理</strong><small>每个 Test 独立选择；prepare-run 后冻结</small></header><label><span>ModelStudent</span><select value={lane.modelStudentId} onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(event) => onModelChange(event.target.value)}>{models.map(modelOption)}</select></label>{capability?.adjustable ? <label><span>推理级别</span><select value={lane.reasoningProfile} onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(event) => onReasoningChange(event.target.value as ReasoningProfile)}>{choices.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(choice) => <option key={choice} value={choice}>{choice === "auto" ? reasoningAutoLabel(capability) : profileLabel(choice, capability)}</option>)}</select></label> : <p className="product-readonly-fact">推理级别：固定 · {capability ? profileLabel(capability.defaultProfile, capability) : "未知"}</p>}</section>;
}

/** 渲染「HistoryFact」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function HistoryFact({ policy }: { policy: ContextLabLane["policy"]["historyPolicy"] }) {
  return <section className="product-history-fact"><History size={15} /><div><strong>{policy.mode === "recent_turns" ? `Agent 历史策略：最近 ${policy.maxTurns} 个完整 Turn（只读）` : "Agent 历史策略：不带历史（只读）"}</strong><small>本次每个 Test 使用全新实验 Session，只运行首轮，实际进入历史为 0；此项仅帮助理解 Agent 配置，不影响本次实验结果。</small></div></section>;
}

/** 执行「modelOption」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function modelOption(model: ModelStudentSummary) {
  return <option key={model.modelStudentId} value={model.modelStudentId}>{joinMetadata([model.displayName, formatContextWindow(model.contextWindowTokens), model.model])}</option>;
}
/** 执行「fingerprint」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function fingerprint(prompt: string, lane: ContextLabLane): string { return JSON.stringify({ prompt, lane }); }
/** 执行「previewLane」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function previewLane(promptText: string, lane: ContextLabLane) {
  return controlApi.contextPreview({ schemaVersion: 2, promptText, test: {
    testId: lane.testId, label: lane.label, sourceAgent: lane.sourceAgent,
    modelStudentId: lane.modelStudentId, reasoningProfile: lane.reasoningProfile, policy: lane.policy,
  } });
}
/** 把未知异常转换为「errorMessage」文本，避免错误序列化过程再次抛出。 */
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
/** 执行「evaluationExperimentUrl」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function evaluationExperimentUrl(id: string): string { return `/evaluation/experiments/${encodeURIComponent(id)}`; }
