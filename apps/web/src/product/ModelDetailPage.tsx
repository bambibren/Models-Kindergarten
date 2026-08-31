import {
  Activity,
  ArrowLeft,
  Bot,
  Check,
  CircleX,
  Gauge,
  KeyRound,
  Link2,
  Network,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Wrench,
} from "lucide-react";
import { useCallback } from "react";
import type { ModelStudentDetailView, ProviderCapabilitySnapshot } from "@kindergarten/contracts";
import { controlApi } from "../api/control-api.js";
import { formatTokenCount } from "../components/tokens/token-format.js";
import { profileLabel } from "../reasoning/reasoning-config.js";
import { ErrorState, LoadingState } from "./LoadState.js";
import { ProductNav } from "./ProductNav.js";
import { useResource } from "./use-resource.js";

/** 渲染模型入园只读详情；不提供任何会改变已安装模型的交互。 */
export function ModelDetailPage({ modelStudentId }: { modelStudentId: string }) {
  const load = useCallback(/** 缓存详情读取函数，模型 ID 变化时重新读取。 */
() => controlApi.model(modelStudentId), [modelStudentId]);
  const { state, retry } = useResource(load);
  return <main className="product-page">
    <ProductNav active="me" />
    <div className="product-editor-shell product-admission-shell">
      <header className="product-page-heading">
        <a aria-label="返回我的 Models" href="/me?tab=models"><ArrowLeft size={16} /></a>
        <div><span>ACCOUNT · MODEL ADMISSION</span><h1>模型入园信息</h1><p>查看模型入园时保存的连接信息、默认设置与实际能力体检结果。此页面只读。</p></div>
      </header>
      {state.phase === "loading"
        ? <LoadingState label="正在读取模型入园信息" />
        : state.phase === "error"
          ? <ErrorState {...state} retry={retry} />
          : <ModelDetailContent detail={state.data} />}
    </div>
  </main>;
}

/** 把服务端安全详情投影为不可编辑的入园表单。 */
export function ModelDetailContent({ detail }: { detail: ModelStudentDetailView }) {
  const { admission } = detail;
  return <div className="product-mcp-layout product-admission-layout">
    <section className="product-form product-admission-form product-model-readonly-form">
      <section>
        <header><Bot size={16} /><div><strong>模型学生</strong><small>只读</small></div></header>
        <ReadonlyField label="模型学生昵称" value={detail.displayName} />
        <ReadonlyField label="当前状态" value={statusLabel(detail.status)} />
      </section>
      <section>
        <header><Network size={16} /><div><strong>连接信息</strong><small>{protocolLabel(admission.protocol)}</small></div></header>
        <ReadonlyField label="接入方式" value={presetLabel(admission.presetId)} />
        <ReadonlyField icon={<Link2 size={14} />} label="Base URL" value={admission.baseUrl} mono />
        <ReadonlyField icon={<Sparkles size={14} />} label="模型 ID" value={detail.model} mono />
        <ReadonlyField icon={<Gauge size={14} />} label="上下文窗口（tokens，可选）" value={detail.contextWindowTokens === undefined ? "未填写" : formatTokenCount(detail.contextWindowTokens)} />
        <ReadonlyField icon={<KeyRound size={14} />} label="API Key" value={credentialLabel(admission.credentialConfigured, admission.credentialHint)} />
        <ReadonlyField label="模型默认思考设置" value={profileLabel(admission.defaultReasoningProfile, admission.snapshot.reasoning.capability)} />
      </section>
      <footer className="product-model-readonly-notice"><ShieldCheck size={15} /><span>只读查看：网页不会回读明文 API Key，也不提供修改或保存入口。</span></footer>
    </section>
    <aside className="product-discovery product-admission-status">
      <header><strong>连接与能力体检</strong><small>入园时由目标接口实际验证</small></header>
      <CapabilityResult snapshot={admission.snapshot} />
      <div className="product-admission-security"><ShieldCheck size={14} /><p>凭据只显示是否已配置及安全提示，不包含 Secret 引用或明文。</p></div>
    </aside>
  </div>;
}

/** 渲染单个可复制但不可编辑的入园字段。 */
function ReadonlyField({ icon, label, mono = false, value }: { icon?: React.ReactNode; label: string; mono?: boolean; value: string }) {
  return <div className="product-admission-field product-model-readonly-field"><span>{label}</span><output className={mono ? "mono" : ""}>{icon}{value}</output></div>;
}

/** 展示持久化的能力体检快照，不重新发起模型调用。 */
function CapabilityResult({ snapshot }: { snapshot: ProviderCapabilitySnapshot }) {
  const facts = [
    { label: "流式文本", value: snapshot.streaming && snapshot.text, icon: Activity },
    { label: "Tool Call", value: snapshot.toolCalls, icon: Wrench },
    { label: "Tool 结果续接", value: snapshot.toolContinuation, icon: RefreshCw },
    { label: "Token Usage", value: snapshot.usage, icon: Gauge },
    { label: "推理摘要", value: snapshot.thought, icon: Sparkles },
  ];
  return <div className="product-admission-result">
    <div className="product-admission-result-heading"><span><Check size={15} /></span><div><strong>接口体检快照</strong><small>{formatDateTime(snapshot.testedAt)}</small></div></div>
    <ul>{facts.map(/** 将能力事实逐项投影，不修改快照。 */
(fact) => { const Icon = fact.icon; return <li key={fact.label}><Icon size={13} /><span>{fact.label}</span><em className={fact.value ? "accepted" : "rejected"}>{fact.value ? <><Check size={11} />已通过</> : <><CircleX size={11} />未通过</>}</em></li>; })}</ul>
    <section><strong>已验证思考档位</strong><div className="product-admission-efforts">{snapshot.reasoning.capability.supportedProfiles.map(/** 将已验证档位转换为中文标签。 */
(profile) => <span key={profile}>{profileLabel(profile, snapshot.reasoning.capability)}</span>)}</div></section>
  </div>;
}

/** 构建 Models 列表进入详情页的安全路径。 */
export function modelStudentDetailUrl(modelStudentId: string): string {
  return `/models/${encodeURIComponent(modelStudentId)}`;
}

function credentialLabel(configured: boolean, hint?: string): string {
  if (!configured) return "无需凭据";
  return hint ? `已安全保存 · ${hint}` : "已安全保存";
}

function presetLabel(presetId: ModelStudentDetailView["admission"]["presetId"]): string {
  if (presetId === "openai") return "OpenAI 官方";
  if (presetId === "siliconflow") return "硅基流动";
  if (presetId === "custom_responses") return "自定义 Responses";
  return "Ollama（历史兼容）";
}

function protocolLabel(protocol: ModelStudentDetailView["admission"]["protocol"]): string {
  if (protocol === "openai_responses") return "Responses API";
  if (protocol === "openai_chat_completions") return "Chat Completions API";
  return "Ollama Native API";
}

function statusLabel(status: ModelStudentDetailView["status"]): string {
  if (status === "ready") return "可用";
  if (status === "capacity_blocked") return "容量受限";
  if (status === "unavailable") return "不可用";
  return "状态未知";
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
