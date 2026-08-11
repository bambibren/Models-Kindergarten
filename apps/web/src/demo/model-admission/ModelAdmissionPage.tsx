import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowLeft,
  Check,
  ChevronDown,
  CircleAlert,
  Cloud,
  Cpu,
  Eye,
  EyeOff,
  Gauge,
  KeyRound,
  Link2,
  MessageSquareText,
  Network,
  Server,
  ShieldCheck,
  Sparkles,
  Wrench,
} from "lucide-react";
import type { DemoModelCapabilities } from "../demo-types.js";
import { DemoTopNav } from "../shared/DemoTopNav.js";
import {
  buildDemoModelStudent,
  createAdmissionDraft,
  type DiscoveredDemoModel,
  type ModelAdmissionDraft,
  type ModelAdmissionProviderId,
  saveModelStudent,
  simulateAdmissionTest,
  switchAdmissionProvider,
  updateAdmissionDraft,
  validateAdmissionDraft,
} from "./model-admission-state.js";
import "./model-admission.css";

type AdmissionPhase = "editing" | "testing" | "selecting_model" | "probing" | "ready" | "failed" | "saving";

const providerCopy: Record<ModelAdmissionProviderId, {
  title: string;
  description: string;
  protocol: string;
  icon: typeof Cpu;
}> = {
  ollama: {
    title: "本地 Ollama",
    description: "检测运行在这台设备上的 Ollama，不需要 API Key。",
    protocol: "Ollama Native",
    icon: Cpu,
  },
  siliconflow: {
    title: "硅基流动",
    description: "使用硅基流动 API Key，连接并选择一个云端模型。",
    protocol: "Chat Completions",
    icon: Cloud,
  },
  custom_responses: {
    title: "自定义 Responses",
    description: "兼容截图中的 Base URL + Bearer Key + Responses API 配置。",
    protocol: "Responses API",
    icon: Network,
  },
};

const providerIds: ModelAdmissionProviderId[] = ["ollama", "siliconflow", "custom_responses"];

export function ModelAdmissionPage() {
  const [draft, setDraft] = useState<ModelAdmissionDraft>(() => createAdmissionDraft("ollama"));
  const [phase, setPhase] = useState<AdmissionPhase>("editing");
  const [models, setModels] = useState<DiscoveredDemoModel[]>([]);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [error, setError] = useState("");
  const [showKey, setShowKey] = useState(false);
  const timerRef = useRef<number | null>(null);
  const selectedModel = models.find((model) => model.id === selectedModelId);
  const validation = useMemo(() => validateAdmissionDraft(draft), [draft]);
  const busy = phase === "testing" || phase === "probing" || phase === "saving";

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  function resetResult() {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    setModels([]);
    setSelectedModelId("");
    setError("");
    setPhase("editing");
  }

  function chooseProvider(providerId: ModelAdmissionProviderId) {
    setDraft((current) => switchAdmissionProvider(current, providerId));
    setShowKey(false);
    resetResult();
  }

  function changeDraft(patch: Partial<Omit<ModelAdmissionDraft, "providerId">>) {
    setDraft((current) => updateAdmissionDraft(current, patch));
    resetResult();
  }

  function changeName(name: string) {
    setDraft((current) => updateAdmissionDraft(current, { name }));
  }

  function testConnection() {
    if (!validation.valid || busy) return;
    setError("");
    setPhase("testing");
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const result = simulateAdmissionTest(draft);
      if (!result.ok) {
        setError(result.error);
        setPhase("failed");
        return;
      }
      setModels(result.models);
      setSelectedModelId(result.models[0]?.id ?? "");
      setPhase("selecting_model");
    }, 760);
  }

  function probeModel() {
    if (!selectedModel || busy) return;
    setPhase("probing");
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setPhase("ready");
    }, 820);
  }

  function finishAdmission() {
    if (phase !== "ready" || !selectedModel) return;
    setPhase("saving");
    const student = buildDemoModelStudent(draft, selectedModel);
    saveModelStudent(sessionStorage, student);
    setDraft((current) => ({ ...current, apiKey: "" }));
    location.href = "/demo/model-home?admitted=1";
  }

  const connectionDone = phase === "selecting_model" || phase === "probing" || phase === "ready" || phase === "saving";
  const modelStepActive = connectionDone;
  const statusModel = selectedModel ?? models[0];

  return <main className="mk-demo-app mk-model-admission-page">
    <DemoTopNav active="home" />
    <div className="mk-admission-shell">
      <header className="mk-admission-heading">
        <a aria-label="返回模型主页" href="/demo/model-home"><ArrowLeft size={16} /></a>
        <div><span className="mk-demo-kicker">MODEL STUDENT · ADMISSION</span><h1>新模型入园</h1><p>先选择接入方式，再验证连接与具体模型。对初次配置只暴露必要字段，高级协议细节由适配层负责。</p></div>
        <span className="mk-admission-demo-badge">INTERACTIVE UI DEMO</span>
      </header>

      <nav className="mk-admission-steps" aria-label="模型入园步骤">
        <Step done active={false} number="1" title="选择来源" detail="本地或云端" />
        <Step done={connectionDone} active={!connectionDone} number="2" title="验证连接" detail="地址与凭据" />
        <Step done={phase === "ready" || phase === "saving"} active={modelStepActive && phase !== "ready" && phase !== "saving"} number="3" title="模型体检" detail="流式与 Tool Call" />
      </nav>

      <div className="mk-admission-layout">
        <form className="mk-admission-form" onSubmit={(event) => { event.preventDefault(); phase === "selecting_model" ? probeModel() : testConnection(); }}>
          <section className="mk-admission-section">
            <header><div><strong>选择接入方式</strong><small>V1 只规划下面三种，不做通用供应商大全。</small></div><span>1 / 3</span></header>
            <div className="mk-admission-provider-list" role="radiogroup" aria-label="模型接入方式">
              {providerIds.map((providerId) => {
                const copy = providerCopy[providerId];
                const Icon = copy.icon;
                const selected = draft.providerId === providerId;
                return <button aria-checked={selected} className={`mk-admission-provider ${selected ? "selected" : ""}`} key={providerId} role="radio" type="button" onClick={() => chooseProvider(providerId)}>
                  <span><Icon size={17} /></span><div><strong>{copy.title}</strong><small>{copy.description}</small></div><em>{copy.protocol}</em>{selected && <Check size={14} />}
                </button>;
              })}
            </div>
          </section>

          <section className="mk-admission-section">
            <header><div><strong>连接信息</strong><small>{draft.providerId === "ollama" ? "检测本地服务和已安装模型。" : "API Key 像密码一样，只用于本次 Demo 内存状态。"}</small></div><span>2 / 3</span></header>
            <div className="mk-admission-fields">
              {draft.providerId === "ollama" && <label><span>Ollama 服务地址</span><div className="mk-admission-input"><Server size={14} /><input aria-label="Ollama 服务地址" inputMode="url" value={draft.baseUrl} onChange={(event) => changeDraft({ baseUrl: event.target.value })} /></div><small>默认是当前设备的 11434 端口；真实 Remote 部署后必须说明 localhost 指向哪里。</small></label>}

              {draft.providerId === "siliconflow" && <>
                <label><span>API Key</span><SecretField label="硅基流动 API Key" show={showKey} value={draft.apiKey} onChange={(apiKey) => changeDraft({ apiKey })} onToggle={() => setShowKey((value) => !value)} /></label>
                <button className="mk-admission-demo-key" type="button" onClick={() => changeDraft({ apiKey: "sk-demo-12345678" })}>使用演示 Key</button>
                <details className="mk-admission-advanced"><summary>高级设置 · 已使用官方预设地址<ChevronDown size={13} /></summary><div className="mk-admission-fixed-field"><Link2 size={14} /><code>{draft.baseUrl}</code></div></details>
              </>}

              {draft.providerId === "custom_responses" && <>
                <label><span>连接名称</span><div className="mk-admission-input"><Cloud size={14} /><input aria-label="连接名称" placeholder="例如：我的 Responses 代理" value={draft.connectionName} onChange={(event) => changeDraft({ connectionName: event.target.value })} /></div><small>用于区分以后可能添加的其他代理或账号，不会发送给模型。</small></label>
                <label><span>Base URL</span><div className="mk-admission-input"><Link2 size={14} /><input aria-label="Responses Base URL" inputMode="url" placeholder="https://example.com/v1" value={draft.baseUrl} onChange={(event) => changeDraft({ baseUrl: event.target.value })} /></div><small>后续真实适配器会向此地址的 <code>/responses</code> 发请求；云端地址只接受 HTTPS。</small></label>
                <label><span>API Key</span><SecretField label="Responses API Key" show={showKey} value={draft.apiKey} onChange={(apiKey) => changeDraft({ apiKey })} onToggle={() => setShowKey((value) => !value)} /></label>
                <button className="mk-admission-demo-key" type="button" onClick={() => changeDraft({ apiKey: "sk-demo-12345678" })}>使用演示 Key</button>
                <label><span>模型 ID</span><div className="mk-admission-input"><Sparkles size={14} /><input aria-label="Responses 模型 ID" placeholder="例如：gpt-5.5" value={draft.modelId} onChange={(event) => changeDraft({ modelId: event.target.value })} /></div><small>与你截图中的 <code>model</code> 对应；这里不读取 Codex 的 config.toml。</small></label>
              </>}
            </div>
          </section>

          {models.length > 0 && <section className="mk-admission-section">
            <header><div><strong>选择要入园的模型</strong><small>读取模型列表不等于模型可用，选中后还要发起最小生成与 Tool Call 体检。</small></div><span>3 / 3</span></header>
            <div className="mk-admission-model-list" role="radiogroup" aria-label="发现的模型">
              {models.map((model) => <label className={selectedModelId === model.id ? "selected" : ""} key={model.id}><input checked={selectedModelId === model.id} name="model" type="radio" value={model.id} onChange={() => { setSelectedModelId(model.id); if (phase === "ready") setPhase("selecting_model"); }} /><span><strong>{model.id}</strong><small>{model.description}</small></span><em>{model.capabilities.toolCalls === "supported" ? "Tool 已发现" : "待确认"}</em></label>)}
            </div>
            <label className="mk-admission-field"><span>入园昵称（可选）</span><div className="mk-admission-input"><MessageSquareText size={14} /><input aria-label="模型学生昵称" placeholder={selectedModel?.name ?? "例如：千问 8B 小朋友"} value={draft.name} onChange={(event) => changeName(event.target.value)} /></div></label>
          </section>}

          <footer className="mk-admission-actions">
            <span>{phase === "ready" ? "体检通过后才可完成入园；评分将在真实任务后产生。" : "本页连接与体检均为确定性前端模拟，不会请求真实服务。"}</span>
            {connectionDone && phase !== "ready" && phase !== "saving" && <button className="secondary" disabled={!selectedModel || busy} type="button" onClick={probeModel}><Activity size={14} />{phase === "probing" ? "正在体检" : "测试这个模型"}</button>}
            {!connectionDone && <button disabled={!validation.valid || busy} type="submit"><Network size={14} />{phase === "testing" ? "正在验证" : phase === "failed" ? "重新测试" : "测试连接并读取模型"}</button>}
            {(phase === "ready" || phase === "saving") && <button disabled={phase === "saving"} type="button" onClick={finishAdmission}><ShieldCheck size={14} />{phase === "saving" ? "正在入园" : "确认入园"}</button>}
          </footer>
        </form>

        <aside className="mk-admission-status" aria-live="polite">
          <header><strong>连接与模型体检</strong><small>发现模型、最小生成、流式、Tool Call 与用量</small></header>
          {(phase === "editing") && <div className="mk-admission-status-empty"><Gauge size={22} /><p>填写当前接入方式所需的信息，然后测试连接。</p></div>}
          {(phase === "testing" || phase === "probing" || phase === "saving") && <div className="mk-admission-status-progress"><div className="mk-admission-progress-track" /><p>{phase === "testing" ? "正在验证地址与凭据，并读取可用模型…" : phase === "probing" ? "正在执行最小流式生成与 Tool Call 体检…" : "正在保存不含明文 Key 的 ModelStudent…"}</p></div>}
          {phase === "failed" && <div className="mk-admission-error" role="alert"><CircleAlert size={18} /><div><strong>连接失败</strong><p>{error}</p><p>修改地址或凭据后会清除本次失败状态，可重新测试。</p></div></div>}
          {(phase === "selecting_model" || phase === "ready") && statusModel && <AdmissionResult capabilities={statusModel.capabilities} model={statusModel} probed={phase === "ready"} provider={providerCopy[draft.providerId].title} />}
          <div className="mk-admission-security-note"><ShieldCheck size={14} /><p>Demo 不访问网络，也不会把输入的 API Key 写入 sessionStorage、模型记录、URL、日志或聊天上下文。请勿输入真实 Key。</p></div>
        </aside>
      </div>
    </div>
  </main>;
}

function Step({ active, detail, done, number, title }: { active: boolean; detail: string; done: boolean; number: string; title: string }) {
  return <div className={`mk-admission-step ${active ? "active" : ""} ${done ? "done" : ""}`}><span>{done ? <Check size={12} /> : number}</span><div><strong>{title}</strong><small>{detail}</small></div></div>;
}

function SecretField({ label, onChange, onToggle, show, value }: { label: string; onChange: (value: string) => void; onToggle: () => void; show: boolean; value: string }) {
  return <div className="mk-admission-secret"><KeyRound size={14} /><input aria-label={label} autoComplete="off" placeholder="只在本页临时输入" type={show ? "text" : "password"} value={value} onChange={(event) => onChange(event.target.value)} /><button aria-label={show ? "隐藏 API Key" : "显示 API Key"} type="button" onClick={onToggle}>{show ? <EyeOff size={14} /> : <Eye size={14} />}</button></div>;
}

function AdmissionResult({ capabilities, model, probed, provider }: { capabilities: DemoModelCapabilities; model: DiscoveredDemoModel; probed: boolean; provider: string }) {
  const items = [
    { id: "streaming", label: "流式输出", detail: "增量文本可稳定返回", icon: Activity },
    { id: "toolCalls", label: "Tool Call", detail: "函数参数与结果可闭环", icon: Wrench },
    { id: "reasoning", label: "推理字段", detail: "可映射推理或 summary", icon: Sparkles },
    { id: "usage", label: "Token 用量", detail: "输入、输出、缓存与推理", icon: Gauge },
  ] as const;
  return <div className="mk-admission-result">
    <div className="mk-admission-result-summary"><span>{probed ? <Check size={16} /> : <Server size={15} />}</span><div><strong>{model.id}</strong><small>{provider} · {probed ? "模型体检通过" : "连接成功，等待体检"}</small></div></div>
    <ul className="mk-admission-capabilities">{items.map((item) => {
      const Icon = item.icon;
      const state = capabilities[item.id];
      return <li key={item.id}><span><Icon size={12} /></span><div><strong>{item.label}</strong><small>{item.detail}</small></div><em>{probed ? capabilityLabel(state) : "待体检"}</em></li>;
    })}</ul>
  </div>;
}

function capabilityLabel(state: DemoModelCapabilities[keyof DemoModelCapabilities]): string {
  if (state === "supported") return "已通过";
  if (state === "unsupported") return "不支持";
  return "未确认";
}
