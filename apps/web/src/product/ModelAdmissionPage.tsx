import {
  Activity,
  ArrowLeft,
  Check,
  CircleAlert,
  Eye,
  EyeOff,
  Gauge,
  KeyRound,
  Link2,
  Network,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Wrench,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type {
  ConcreteReasoningProfile,
  ModelProviderPresetView,
  ModelStudentTestRecord,
  ProviderCapabilitySnapshot,
} from "@kindergarten/contracts";
import { ControlApiError, controlApi } from "../api/control-api.js";
import { profileLabel } from "../reasoning/reasoning-config.js";
import { ModelDefaultReasoningSelect } from "./ModelDefaultReasoningSelect.js";
import { ProductNav } from "./ProductNav.js";
import {
  acceptSuccessfulModelStudentTest,
  beginModelAdmissionTest,
  buildModelStudentInstallInput,
  buildModelStudentCandidate,
  createModelAdmissionState,
  initializeModelAdmissionPresets,
  modelStudentHomeUrl,
  selectModelAdmissionPreset,
  selectedModelProviderPreset,
  updateModelAdmissionConnection,
  updateModelAdmissionDefaultReasoningProfile,
  updateModelAdmissionDisplayName,
  validateModelAdmissionDraft,
  visibleModelAdmissionErrors,
  type ModelAdmissionFieldErrors,
  type ModelAdmissionViewState,
} from "./model-admission-state.js";

export function ModelAdmissionPage() {
  const [state, setState] = useState<ModelAdmissionViewState>(createModelAdmissionState);
  const [presets, setPresets] = useState<ModelProviderPresetView[]>([]);
  const [showKey, setShowKey] = useState(false);
  const alive = useRef(true);
  const secret = useRef("");
  const preset = useMemo(
    () => selectedModelProviderPreset(presets, state.draft.presetId),
    [presets, state.draft.presetId],
  );
  const validation = useMemo(() => validateModelAdmissionDraft(state.draft, preset), [state.draft, preset]);
  const errors = visibleModelAdmissionErrors(state.draft, validation.errors, state.fieldErrors);
  const busy = state.phase === "testing" || state.phase === "installing";
  const hasVerifiedTest = state.test?.state === "succeeded"
    && Boolean(state.test.snapshot)
    && state.defaultReasoningProfile !== undefined;

  useEffect(() => {
    void controlApi.modelProviderPresets().then(({ items }) => {
      if (!alive.current) return;
      setPresets(items);
      setState((current) => initializeModelAdmissionPresets(current, items));
    }, (error) => {
      if (!alive.current) return;
      setState((current) => ({ ...current, phase: "failed", error: errorMessage(error) }));
    });
    return () => {
      alive.current = false;
      secret.current = "";
    };
  }, []);

  function changeConnection(patch: Parameters<typeof updateModelAdmissionConnection>[1]) {
    if (patch.apiKey !== undefined) secret.current = patch.apiKey;
    setState((current) => updateModelAdmissionConnection(current, patch));
  }

  function changePreset(next: ModelProviderPresetView) {
    secret.current = "";
    setShowKey(false);
    setState((current) => selectModelAdmissionPreset(current, next));
  }

  async function testConnection(event?: FormEvent) {
    event?.preventDefault();
    const checked = validateModelAdmissionDraft(state.draft, preset);
    if (!checked.valid || busy || !preset) return;
    setState(beginModelAdmissionTest);
    try {
      const result = await controlApi.testModelStudent(buildModelStudentCandidate({
        ...state.draft,
        apiKey: secret.current,
      }, preset));
      if (!alive.current) return;
      if (result.state !== "succeeded" || !result.snapshot) {
        setState((current) => ({
          phase: "failed",
          draft: current.draft,
          fieldErrors: {},
          test: result,
          error: result.error?.message ?? testStateMessage(result.state),
        }));
        return;
      }
      setState((current) => acceptSuccessfulModelStudentTest(current, result));
    } catch (error) {
      if (!alive.current) return;
      setState((current) => ({
        phase: "failed",
        draft: current.draft,
        fieldErrors: controlFieldErrors(error),
        error: errorMessage(error),
      }));
    }
  }

  async function install() {
    if (!hasVerifiedTest || !state.test || busy) return;
    setState((current) => {
      const { error: _error, ...next } = current;
      return { ...next, phase: "installing" };
    });
    try {
      const student = await controlApi.installModelStudent(buildModelStudentInstallInput(state));
      secret.current = "";
      setShowKey(false);
      if (!alive.current) return;
      setState((current) => ({
        ...current,
        draft: { ...current.draft, apiKey: "" },
      }));
      location.href = modelStudentHomeUrl(student.modelStudentId);
    } catch (error) {
      if (!alive.current) return;
      setState((current) => ({
        ...current,
        phase: "failed",
        fieldErrors: controlFieldErrors(error),
        error: errorMessage(error),
      }));
    }
  }

  return <main className="product-page">
    <ProductNav active="me" />
    <div className="product-editor-shell product-admission-shell">
      <header className="product-page-heading">
        <a aria-label="返回我的 Models" href="/me?tab=models"><ArrowLeft size={16} /></a>
        <div><span>ADMIN · MODEL ADMISSION</span><h1>新模型入园</h1><p>选择服务商或协议接入方式。MK 会针对目标模型验证流式输出、Tool 闭环与推理控制，再保存为模型学生。</p></div>
      </header>

      <div className="product-mcp-layout product-admission-layout">
        <form className="product-form product-admission-form" noValidate onSubmit={(event) => void testConnection(event)}>
          <section>
            <header><Network size={16} /><div><strong>接入方式</strong><small>不同协议由各自 Adapter 验证和运行</small></div></header>
            <div className="product-admission-presets" role="radiogroup" aria-label="模型接入方式">
              {presets.map((item) => <button
                aria-checked={item.presetId === state.draft.presetId}
                className={item.presetId === state.draft.presetId ? "selected" : ""}
                disabled={busy}
                key={item.presetId}
                role="radio"
                type="button"
                onClick={() => changePreset(item)}
              ><span><strong>{item.displayName}</strong><small>{item.description}</small></span>{item.presetId === state.draft.presetId && <Check size={14} />}</button>)}
              {state.phase === "loading" && <span className="product-admission-presets-loading">正在读取可用接入方式…</span>}
            </div>
          </section>

          <section>
            <header><Sparkles size={16} /><div><strong>模型学生</strong><small>这个名字只在 MK 内展示</small></div></header>
            <AdmissionField label="模型学生昵称" error={errors.displayName} help="例如：大聪明。修改昵称不会让已通过的能力体检失效。" inputId="model-display-name">
              <input
                aria-invalid={Boolean(errors.displayName)}
                aria-describedby="model-display-name-description"
                disabled={busy}
                id="model-display-name"
                maxLength={80}
                placeholder="例如：大聪明"
                value={state.draft.displayName}
                onChange={(event) => setState((current) => updateModelAdmissionDisplayName(current, event.target.value))}
              />
            </AdmissionField>
          </section>

          <section>
            <header><Network size={16} /><div><strong>连接信息</strong><small>{preset ? `${protocolLabel(preset)} · ${preset.auth.apiKeyLabel}` : "等待选择接入方式"}</small></div></header>
            {preset && <div className="product-admission-protocol"><Network size={15} /><span><strong>{preset.displayName}</strong><small>{preset.baseUrl.mode === "fixed" ? "服务地址由接入方式安全预设；模型能力仍以实际体检为准。" : "使用自定义公网 HTTPS 地址；模型能力以该目标接口的实际体检为准。"}</small></span></div>}
            {preset?.baseUrl.mode === "editable" && <AdmissionField label="Base URL" error={errors.baseUrl} help="填写服务根地址；不能带查询参数、凭据或具体请求方法路径。" inputId="model-base-url">
              <div className="product-admission-input"><Link2 size={14} /><input
                aria-invalid={Boolean(errors.baseUrl)}
                aria-describedby="model-base-url-description"
                disabled={busy}
                id="model-base-url"
                inputMode="url"
                maxLength={2_048}
                placeholder="https://api.example.com/v1"
                value={state.draft.baseUrl}
                onChange={(event) => changeConnection({ baseUrl: event.target.value })}
              /></div>
            </AdmissionField>}
            <AdmissionField label="模型 ID" error={errors.model} help="使用服务商要求的原始模型 ID；MK 不会根据名称猜测能力。" inputId="model-provider-id">
              <div className="product-admission-input"><Sparkles size={14} /><input
                aria-invalid={Boolean(errors.model)}
                aria-describedby="model-provider-id-description"
                disabled={busy}
                id="model-provider-id"
                maxLength={200}
                placeholder="服务商提供的模型 ID"
                value={state.draft.model}
                onChange={(event) => changeConnection({ model: event.target.value })}
              /></div>
            </AdmissionField>
            <AdmissionField label={preset?.auth.apiKeyLabel ?? "API Key"} error={errors.apiKey} help="凭据格式由服务商决定；MK 不根据前缀判断服务商或能力。" inputId="model-api-key">
              <div className="product-admission-secret"><KeyRound size={14} /><input
                aria-invalid={Boolean(errors.apiKey)}
                aria-describedby="model-api-key-description"
                autoComplete="off"
                disabled={busy}
                id="model-api-key"
                maxLength={8_192}
                placeholder="仅用于真实体检和安全保存"
                spellCheck={false}
                type={showKey ? "text" : "password"}
                value={state.draft.apiKey}
                onChange={(event) => changeConnection({ apiKey: event.target.value })}
              /><button aria-label={showKey ? "隐藏 API Key" : "显示 API Key"} disabled={busy} type="button" onClick={() => setShowKey((value) => !value)}>{showKey ? <EyeOff size={14} /> : <Eye size={14} />}</button></div>
            </AdmissionField>
            <div className="product-admission-caution"><ShieldCheck size={15} /><p>点击体检会产生少量真实模型调用，可能消耗服务商额度。API Key 与探测内容只会发送到当前选择的服务；使用自定义地址时，请确认该地址可信。</p></div>
          </section>

          <footer>
            <span className={state.phase === "failed" ? "failed" : ""}>{actionMessage(state)}</span>
            {hasVerifiedTest && state.phase !== "installing" && <button disabled={busy} type="button" onClick={() => void testConnection()}><RefreshCw size={14} />重新体检</button>}
            {hasVerifiedTest || state.phase === "installing"
              ? <button disabled={busy} type="button" onClick={() => void install()}><Check size={14} />{state.phase === "installing" ? "正在入园" : state.phase === "failed" ? "重试入园" : "确认入园"}</button>
              : <button disabled={busy || !validation.valid} type="submit"><Activity size={14} />{state.phase === "testing" ? "正在体检" : "测试连接与能力"}</button>}
          </footer>
        </form>

        <aside className="product-discovery product-admission-status" aria-live="polite">
          <header><strong>连接与能力体检</strong><small>只展示目标接口实际返回的事实</small></header>
          {state.phase === "editing" && <AdmissionEmpty />}
          {(state.phase === "testing" || state.phase === "installing") && <AdmissionProgress phase={state.phase} />}
          {state.phase === "failed" && <AdmissionFailure message={state.error ?? "操作没有完成，请检查配置后重试。"} />}
          {(state.phase === "verified" || state.phase === "installing" || (state.phase === "failed" && hasVerifiedTest)) && state.test?.snapshot && <AdmissionResult
            busy={busy}
            defaultReasoningProfile={state.defaultReasoningProfile ?? state.test.snapshot.reasoning.capability.defaultProfile}
            onDefaultReasoningProfileChange={(profile) => setState((current) => updateModelAdmissionDefaultReasoningProfile(current, profile))}
            snapshot={state.test.snapshot}
          />}
          <div className="product-admission-security"><ShieldCheck size={14} /><p>API Key 不会进入 URL、浏览器存储、聊天记录或公开模型信息。确认入园后，网页不能再次读取明文。</p></div>
        </aside>
      </div>
    </div>
  </main>;
}

function AdmissionField({ children, error, help, inputId, label }: { children: React.ReactNode; error: string | undefined; help: string; inputId: string; label: string }) {
  const descriptionId = `${inputId}-description`;
  return <label className="product-admission-field" htmlFor={inputId}><span>{label}</span>{children}<small className={error ? "error" : ""} id={descriptionId}>{error ?? help}</small></label>;
}

function AdmissionEmpty() {
  return <div className="product-admission-empty"><Gauge size={22} /><strong>等待真实体检</strong><p>选择接入方式并填写连接信息后，MK 会按对应协议验证目标模型，不会按名称套用能力。</p></div>;
}

function AdmissionProgress({ phase }: { phase: "testing" | "installing" }) {
  return <div className="product-admission-progress"><div aria-hidden="true"><span /></div><strong>{phase === "testing" ? "正在验证目标模型" : "正在安全保存模型"}</strong><p>{phase === "testing" ? "依次检查该协议的流式终态、Tool 结果续接、用量字段与原生推理控制。" : "能力事实已经冻结，正在创建可供 Session 绑定的 ModelStudent。"}</p></div>;
}

function AdmissionFailure({ message }: { message: string }) {
  return <div className="product-admission-failure" role="alert"><CircleAlert size={18} /><div><strong>没有完成入园</strong><p>{message}</p><small>当前输入会保留；修改连接信息后可重新体检。</small></div></div>;
}

function AdmissionResult({ busy, defaultReasoningProfile, onDefaultReasoningProfileChange, snapshot }: {
  busy: boolean;
  defaultReasoningProfile: ConcreteReasoningProfile;
  onDefaultReasoningProfileChange: (profile: ConcreteReasoningProfile) => void;
  snapshot: ProviderCapabilitySnapshot;
}) {
  const facts = [
    { label: "流式文本", value: snapshot.streaming && snapshot.text, icon: Activity },
    { label: "Tool Call", value: snapshot.toolCalls, icon: Wrench },
    { label: "Tool 结果续接", value: snapshot.toolContinuation, icon: RefreshCw },
    { label: "Token Usage", value: snapshot.usage, icon: Gauge },
    { label: "推理摘要", value: snapshot.thought, icon: Sparkles },
  ];
  const profiles = Object.entries(snapshot.reasoning.nativeByProfile) as Array<[
    ConcreteReasoningProfile,
    Record<string, string | number | boolean>,
  ]>;
  return <div className="product-admission-result">
    <div className="product-admission-result-heading"><span><Check size={15} /></span><div><strong>接口体检完成</strong><small>{new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(snapshot.testedAt))}</small></div></div>
    <ul>{facts.map((fact) => { const Icon = fact.icon; return <li key={fact.label}><Icon size={13} /><span>{fact.label}</span><em className={fact.value ? "accepted" : "rejected"}>{fact.value ? "已通过" : "未通过"}</em></li>; })}</ul>
    <ModelDefaultReasoningSelect
      capability={snapshot.reasoning.capability}
      disabled={busy}
      onChange={onDefaultReasoningProfileChange}
      value={defaultReasoningProfile}
    />
    <section><strong>对话中可选的思考控制</strong><div className="product-admission-profile-map">{profiles.map(([profile, native]) => <span key={profile}><b>{profileLabel(profile, snapshot.reasoning.capability)}</b><code>{nativeReasoningLabel(native)}</code></span>)}</div><p>这里只展示该目标模型体检确认的原生请求参数，不代表已经评估不同设置的推理效果。</p></section>
  </div>;
}

function actionMessage(state: ModelAdmissionViewState): string {
  if (state.phase === "loading") return "正在读取 Remote 提供的接入方式。";
  if (state.phase === "testing") return "体检会发出多次低输出上游请求，请保持页面打开。";
  if (state.phase === "verified") return "真实能力已经确认；昵称仍可修改。";
  if (state.phase === "installing") return "正在写入安全凭据并注册 ModelStudent。";
  if (state.phase === "failed") return state.error ?? "操作失败，请检查后重试。";
  return "先体检，再确认入园；不会只根据模型名称猜测能力。";
}

function protocolLabel(preset: ModelProviderPresetView): string {
  if (preset.protocol === "openai_responses") return "Responses API";
  if (preset.protocol === "openai_chat_completions") return "Chat Completions API";
  return "Messages API";
}

function nativeReasoningLabel(native: Record<string, string | number | boolean>): string {
  return Object.entries(native).map(([key, value]) => `${key}=${String(value)}`).join(" · ") || "固定";
}

function testStateMessage(state: ModelStudentTestRecord["state"]): string {
  if (state === "expired") return "本次体检已经过期，请重新测试。";
  if (state === "testing") return "体检尚未完成，请稍后重试。";
  return "目标接口没有通过能力体检。";
}

function controlFieldErrors(error: unknown): ModelAdmissionFieldErrors {
  if (!(error instanceof ControlApiError) || !error.fieldErrors) return {};
  const result: ModelAdmissionFieldErrors = {};
  for (const item of error.fieldErrors) {
    const field = item.path.replace(/^\/?/, "").split(/[./]/).at(-1);
    if (field === "displayName" || field === "baseUrl" || field === "model" || field === "apiKey") result[field] = item.message;
  }
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
