import { Beaker, Check, LockKeyhole, Plus, Trash2 } from "lucide-react";
import { useCallback, useState, type FormEvent } from "react";
import type { AgentRecord, ExperimentContextPolicy, ExperimentDraftInput } from "@kindergarten/contracts";
import { controlApi, type TurnContextSnapshot } from "../api/control-api.js";
import { formatContextWindow, joinMetadata } from "../components/tokens/token-format.js";
import { ErrorState, LoadingState } from "./LoadState.js";
import { ProductNav } from "./ProductNav.js";
import { useResource } from "./use-resource.js";

interface Lane {
  variantId: string;
  label: "A" | "B" | "C";
  mode: "rerun" | "reuse_snapshot";
  importedAgentId: string;
  policy: ExperimentContextPolicy;
  locked: boolean;
}

export function ContextLabPage() {
  const turnId = new URLSearchParams(location.search).get("turnId") ?? undefined;
  const load = useCallback(async () => {
    const [agents, models, source] = await Promise.all([
      controlApi.agents(),
      controlApi.models(),
      turnId ? controlApi.turnContext(turnId) : Promise.resolve(undefined),
    ]);
    return { agents: agents.items, models: models.items.filter((item) => item.status === "ready"), source };
  }, [turnId]);
  const { state, retry } = useResource(load);
  return <main className="product-page"><ProductNav active="context" />{
    state.phase === "loading" ? <LoadingState label={turnId ? "正在读取不可变 Turn 快照" : "正在读取实验能力"} />
      : state.phase === "error" ? <ErrorState {...state} retry={retry} />
        : <ContextLabReady agents={state.data.agents} models={state.data.models} source={state.data.source} />
  }</main>;
}

function ContextLabReady({ agents, models, source }: {
  agents: AgentRecord[];
  models: Awaited<ReturnType<typeof controlApi.models>>["items"];
  source: TurnContextSnapshot | undefined;
}) {
  const initialAgent = agents.find((item) => item.agentId === source?.turn.agentId) ?? agents[0];
  const initialPolicy = source?.sourcePolicy ?? (initialAgent ? policyFromAgent(initialAgent) : emptyPolicy());
  const [name, setName] = useState(source ? "历史 Turn 上下文对照" : "上下文策略对照");
  const [prompt, setPrompt] = useState(source?.promptText ?? "");
  const [modelId, setModelId] = useState(source?.turn.modelStudentId ?? models[0]?.modelStudentId ?? "");
  const [sourceAgentId] = useState(source?.turn.agentId ?? initialAgent?.agentId ?? "");
  const [lanes, setLanes] = useState<Lane[]>(() => initialLanes(initialAgent, initialPolicy, Boolean(source)));
  const [toolExpected, setToolExpected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [previews, setPreviews] = useState<Record<string, { tokens: number; sources: number; inputBytes: number }>>({});

  function importAgent(index: number, agentId: string) {
    const agent = agents.find((item) => item.agentId === agentId);
    if (!agent) return;
    setLanes((current) => current.map((lane, itemIndex) => itemIndex === index ? { ...lane, importedAgentId: agentId, policy: policyFromAgent(agent) } : lane));
  }
  function patchPolicy(index: number, change: (policy: ExperimentContextPolicy) => ExperimentContextPolicy) {
    setLanes((current) => current.map((lane, itemIndex) => itemIndex === index && !lane.locked ? { ...lane, policy: change(lane.policy) } : lane));
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      const input: ExperimentDraftInput = {
        name,
        mode: source ? "history_turn" : "fresh_prompt",
        modelStudentId: modelId,
        sourceAgentId,
        promptText: prompt,
        ...(source ? { sourceTurnId: source.turn.turnId } : {}),
        toolUseWasExpected: toolExpected,
        variants: lanes.map(({ variantId, label, mode, policy }) => ({ variantId, label, mode, policy })),
      };
      const experiment = await controlApi.createExperiment(input);
      location.href = evaluationExperimentUrl(experiment.experimentId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error)); setBusy(false);
    }
  }
  async function previewLane(lane: Lane) {
    setMessage(`正在预览版本 ${lane.label}…`);
    try {
      const value = await controlApi.contextPreview({ modelStudentId: modelId, promptText: prompt, policy: lane.policy, ...(source ? { sourceTurnId: source.turn.turnId } : {}) });
      setPreviews((current) => ({ ...current, [lane.variantId]: { tokens: value.contextSummary.totalEstimatedTokens, sources: value.contextSummary.items.length, inputBytes: new TextEncoder().encode(value.providerInput.value).byteLength } }));
      setMessage(`版本 ${lane.label} 已使用真实 serializer 生成预览。`);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }

  const distinct = new Set(lanes.map((item) => JSON.stringify(item.policy))).size >= 2;
  return <div className="product-context-shell">
    <header className="product-context-heading"><span>MODEL CONTEXT · EXPERIMENT</span><h1>模型上下文实验</h1><p>{source ? "A 复用原回答、不请求模型；B/C 在隔离实验会话中真实重跑。" : "同一模型、同一问题，只比较 2–3 种受控 Agent 策略。"}</p></header>
    {source && <section className="product-source-snapshot"><LockKeyhole size={15} /><div><strong>历史 Turn 快照</strong><small>{source.turn.turnId} · Agent snapshot {source.agentSnapshotHash.slice(0, 10)} · {source.modelRounds.length} 个 model round</small></div></section>}
    <form onSubmit={(event) => void submit(event)}>
      <section className="product-context-prompt">
        <label><span>实验名称</span><input required value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label><span>实验问题</span><textarea readOnly={Boolean(source)} required rows={4} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="输入要让不同策略共同回答的问题…" /></label>
        <div><label><span>ModelStudent</span><select disabled={Boolean(source)} value={modelId} onChange={(event) => setModelId(event.target.value)}>{models.map((item) => <option key={item.modelStudentId} value={item.modelStudentId}>{joinMetadata([item.displayName, formatContextWindow(item.contextWindowTokens), item.model])}</option>)}</select></label><label className="product-checkbox"><input checked={toolExpected} type="checkbox" onChange={(event) => setToolExpected(event.target.checked)} /><span>这个任务预期必须使用 Tool</span></label></div>
      </section>
      <section className="product-lanes"><header><div><strong>上下文版本</strong><small>策略包含 system、Tools、Skills、MCP 与 history；memory 固定关闭</small></div><button disabled={lanes.length >= 3} type="button" onClick={() => setLanes((current) => [...current, makeLane("C", "rerun", initialAgent, tweak(initialPolicy), false)])}><Plus size={13} />添加 C</button></header>
        <div className={`lanes-${lanes.length}`}>{lanes.map((lane, index) => <article key={lane.variantId}><header><span>{lane.label}</span><div><strong>版本 {lane.label}</strong><small>{lane.mode === "reuse_snapshot" ? "复用原始快照 · 不重跑" : "隔离 Session · 真实 Runtime"}</small></div>{lane.locked ? <LockKeyhole size={12} /> : lanes.length > 2 && <button aria-label={`删除版本 ${lane.label}`} type="button" onClick={() => setLanes((current) => current.filter((_, itemIndex) => itemIndex !== index))}><Trash2 size={12} /></button>}</header>
          {!lane.locked && <label><span>导入 Agent 策略</span><select value={lane.importedAgentId} onChange={(event) => importAgent(index, event.target.value)}>{agents.map((item) => <option key={item.agentId} value={item.agentId}>{item.name}</option>)}</select></label>}
          <label><span>系统提示</span><textarea readOnly={lane.locked} rows={7} value={lane.policy.systemPrompt} onChange={(event) => patchPolicy(index, (policy) => ({ ...policy, systemPrompt: event.target.value }))} /></label>
          <fieldset disabled={lane.locked}><legend>内置 Tools</legend>{lane.policy.builtinTools.map((tool) => <label className="product-lane-check" key={tool.toolId}><input checked={tool.enabled} type="checkbox" onChange={(event) => patchPolicy(index, (policy) => ({ ...policy, builtinTools: policy.builtinTools.map((item) => item.toolId === tool.toolId ? { ...item, enabled: event.target.checked } : item) }))} /><span>{tool.toolId}</span></label>)}</fieldset>
          <label><span>History</span><select disabled={lane.locked} value={lane.policy.historyPolicy.mode === "none" ? "none" : String(lane.policy.historyPolicy.maxTurns)} onChange={(event) => patchPolicy(index, (policy) => ({ ...policy, historyPolicy: event.target.value === "none" ? { mode: "none" } : { mode: "recent_turns", maxTurns: Number(event.target.value) } }))}><option value="none">不带历史</option><option value="4">最近 4 Turns</option><option value="12">最近 12 Turns</option><option value="24">最近 24 Turns</option></select></label>
          <div className="product-policy-facts"><span>{lane.policy.skillInstallationIds.length} Skills</span><span>{lane.policy.mcps.filter((item) => item.enabled).length} MCPs</span><span>Memory off</span></div>
          <button className="product-preview-button" type="button" onClick={() => void previewLane(lane)}>生成真实输入预览</button>
          {previews[lane.variantId] && <div className="product-preview-facts"><span>约 {previews[lane.variantId]!.tokens} tokens</span><span>{previews[lane.variantId]!.sources} 个来源</span><span>{previews[lane.variantId]!.inputBytes} bytes provider input</span></div>}
        </article>)}</div>
      </section>
      <footer className="product-context-runbar"><span>{message || "运行事实保存在 Remote；evaluation-web 只用 experimentId 查询。"}</span><button disabled={busy || !prompt.trim() || lanes.length < 2 || !distinct} type="submit"><Beaker size={15} />{busy ? "正在创建" : "开始对比实验"}</button></footer>
    </form>
  </div>;
}

function initialLanes(agent: AgentRecord | undefined, policy: ExperimentContextPolicy, history: boolean): Lane[] {
  return [
    makeLane("A", history ? "reuse_snapshot" : "rerun", agent, policy, history),
    makeLane("B", "rerun", agent, tweak(policy), false),
  ];
}
function makeLane(label: "A" | "B" | "C", mode: Lane["mode"], agent: AgentRecord | undefined, policy: ExperimentContextPolicy, locked: boolean): Lane {
  return { variantId: crypto.randomUUID(), label, mode, importedAgentId: agent?.agentId ?? "", policy: structuredClone(policy), locked };
}
function tweak(policy: ExperimentContextPolicy): ExperimentContextPolicy { return { ...structuredClone(policy), systemPrompt: `${policy.systemPrompt}\n\n回答前先列出简短计划，并逐项核对用户要求。` }; }
function policyFromAgent(agent: AgentRecord): ExperimentContextPolicy { return { systemPrompt: agent.systemPrompt, builtinTools: agent.builtinTools, skillInstallationIds: agent.skills.filter((item) => item.enabled).map((item) => item.skillInstallationId), mcps: agent.mcps, historyPolicy: agent.historyPolicy, memoryPolicy: { mode: "off" } }; }
function emptyPolicy(): ExperimentContextPolicy { return { systemPrompt: "你是 Models Kindergarten Agent。", builtinTools: [], skillInstallationIds: [], mcps: [], historyPolicy: { mode: "none" }, memoryPolicy: { mode: "off" } }; }
function evaluationExperimentUrl(id: string): string { return new URL(`/evaluation/experiments/${encodeURIComponent(id)}`, import.meta.env.VITE_EVALUATION_WEB_URL ?? "http://127.0.0.1:5175").toString(); }
