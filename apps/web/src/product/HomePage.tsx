import { ArrowUp, BookOpenText, Bot, Check, ChevronDown, Code2, FlaskConical, GraduationCap, UserPlus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { AgentRecord, ModelStudentSummary, ReasoningProfile } from "@kindergarten/contracts";
import { controlApi } from "../api/control-api.js";
import { ReasoningProfileSelect } from "../components/reasoning/ReasoningProfileSelect.js";
import { availableReasoningProfiles, profileLabel } from "../reasoning/reasoning-config.js";
import { ProductNav } from "./ProductNav.js";
import { ErrorState, LoadingState } from "./LoadState.js";
import { useResource } from "./use-resource.js";

const websitePrompt = `请先调用 ensure_agent_skills，把以下 3 个 Skills 安装到当前 Agent 并自动启用，全部就绪后再开始任务：
https://github.com/anthropics/skills/tree/main/skills/frontend-design
https://github.com/nexu-io/open-design/tree/main/skills/design-brief
https://github.com/nexu-io/open-design/tree/main/skills/impeccable-design-polish

请为 Models Kindergarten 制作一个可直接预览的静态网站，把最终 HTML 写入 index.html。`;

export function HomePage() {
  const load = useCallback(async () => {
    const [models, agents, sessions] = await Promise.all([controlApi.models(), controlApi.agents(), controlApi.sessions()]);
    return { models: models.items, agents: agents.items, sessions: sessions.items };
  }, []);
  const { state, retry } = useResource(load);
  if (state.phase === "loading") return <Page><LoadingState label="正在读取模型、Agent 与会话" /></Page>;
  if (state.phase === "error") return <Page><ErrorState {...state} retry={retry} /></Page>;
  return <HomeReady {...state.data} />;
}

function HomeReady({ models, agents, sessions }: { models: ModelStudentSummary[]; agents: AgentRecord[]; sessions: Awaited<ReturnType<typeof controlApi.sessions>>["items"] }) {
  const readyModels = models.filter((item) => item.status === "ready");
  const [prompt, setPrompt] = useState("");
  const [modelId, setModelId] = useState(() => selectInitialModelStudentId(readyModels, location.search));
  const [agentId, setAgentId] = useState(agents[0]?.agentId ?? "");
  const [reasoningProfile, setReasoningProfile] = useState<ReasoningProfile>("auto");
  const modelPicker = useRef<HTMLDetailsElement>(null);
  const agentPicker = useRef<HTMLDetailsElement>(null);
  const model = models.find((item) => item.modelStudentId === modelId) ?? models[0];
  const agent = agents.find((item) => item.agentId === agentId) ?? agents[0];
  const reasoningProfiles = useMemo(() => availableReasoningProfiles(model?.supports.reasoning), [model]);
  const isWebsite = prompt.includes("ensure_agent_skills") && prompt.includes("frontend-design");
  useEffect(() => {
    if (reasoningProfiles.length === 0 || !reasoningProfiles.includes(reasoningProfile)) setReasoningProfile("auto");
  }, [modelId, reasoningProfile, reasoningProfiles]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!prompt.trim() || !modelId || !agentId) return;
    const launch = await controlApi.createSessionLaunch({
      promptText: prompt.trim(), modelStudentId: modelId, agentId,
      ...(reasoningProfile === "auto" ? {} : { reasoningProfileOverride: reasoningProfile }),
    });
    location.href = `/session?launchId=${encodeURIComponent(launch.launchId)}`;
  }
  return <Page><section className="product-home-main">
    <header className="product-hero">
      <div className="product-model-controls"><details className="product-picker" ref={modelPicker}><summary><span><GraduationCap size={20} /></span><div><small>当前模型学生</small><strong>{model?.displayName ?? "没有可用模型"}</strong><em>{model ? `${model.model} · ${model.providerKind}` : "Remote 未配置"}</em></div><b>{model?.status === "ready" ? "可用" : "不可用"}</b><ChevronDown size={15} /></summary>
          <div>{models.map((item) => <button disabled={item.status !== "ready"} key={item.modelStudentId} type="button" onClick={() => { setModelId(item.modelStudentId); modelPicker.current?.removeAttribute("open"); }}><span><GraduationCap size={14} /></span><div><strong>{item.displayName}</strong><small>{item.model} · {item.status === "ready" ? "可用" : item.statusMessage ?? "不可用"}</small></div>{item.modelStudentId === modelId && <Check size={13} />}</button>)}</div>
        </details><a className="product-model-admission-link" href="/models/new"><UserPlus size={15} />新模型入园</a></div>
      <h1>今天想让模型学习什么？</h1><p>选择一个真实 Agent 开始任务，或比较不同上下文策略。</p>
      <div className="product-capability-cards">
        <button aria-label="小说创作（功能调研中）" disabled type="button"><BookOpenText size={17} /><span><strong>小说创作</strong><small>功能调研中</small></span></button>
        <button className={isWebsite ? "active" : ""} type="button" onClick={() => setPrompt(websitePrompt)}><Code2 size={17} /><span><strong>网站开发</strong><small>显式安装 3 个 Skills 后生成 HTML</small></span></button>
        <a href="/context-lab"><FlaskConical size={17} /><span><strong>模型上下文实验</strong><small>比较 2–3 种真实策略</small></span></a>
      </div>
      <form className="product-home-composer" onSubmit={(event) => void submit(event)}><textarea aria-label="给 ModelStudent 发送消息" rows={isWebsite ? 8 : 3} placeholder="给 ModelStudent 发送消息…" value={prompt} onChange={(event) => setPrompt(event.target.value)} /><footer><div className="product-home-settings"><details className="product-agent-picker" ref={agentPicker}><summary><Bot size={13} /><strong>{agent?.name ?? "没有 Agent"}</strong><ChevronDown size={13} /></summary><div>{agents.map((item) => <button type="button" key={item.agentId} onClick={() => { setAgentId(item.agentId); agentPicker.current?.removeAttribute("open"); }}><Bot size={13} /><span><strong>{item.name}</strong><small>{item.description ?? "未填写说明"}</small></span>{item.agentId === agentId && <Check size={12} />}</button>)}</div></details>{reasoningProfiles.length > 1 && <ReasoningProfileSelect {...(model ? { capability: model.supports.reasoning } : {})} choices={reasoningProfiles.map((profile) => ({ profile, name: profileLabel(profile, model?.supports.reasoning) }))} label="新会话思考控制" onChange={setReasoningProfile} value={reasoningProfile} />}</div><span>创建后，Agent 与模型固定在该会话中</span><button aria-label="发送" disabled={!prompt.trim() || !modelId || !agentId} type="submit"><ArrowUp size={16} /></button></footer></form>
    </header>
    <section className="product-recent"><header><span>ADMIN · RECENT SESSIONS</span><h2>最近会话</h2></header>{sessions.length === 0 ? <div className="product-empty"><strong>还没有会话</strong><p>从上方输入一个任务即可开始。</p></div> : <div>{sessions.slice(0, 6).map((session) => <a href={`/sessions/${encodeURIComponent(session.sessionId)}`} key={session.sessionId}><span><strong>{session.title}</strong><small>{session.preview || "暂无消息"}</small></span><time>{formatDate(session.updatedAt)}</time></a>)}</div>}</section>
  </section></Page>;
}

function Page({ children }: { children: React.ReactNode }) { return <main className="product-page"><ProductNav active="home" />{children}</main>; }
function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }

export function selectInitialModelStudentId(models: ModelStudentSummary[], search: string): string {
  const requested = new URLSearchParams(search).get("modelStudentId");
  return models.find((item) => item.modelStudentId === requested)?.modelStudentId ?? models[0]?.modelStudentId ?? "";
}
