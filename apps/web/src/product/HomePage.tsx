import { ArrowUp, Bot, Check, ChevronDown, Code2, FileArchive, FileCode2, FileText, FlaskConical, GraduationCap, Presentation, Search, UserPlus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { AgentRecord, ArtifactRecord, ModelStudentSummary, ReasoningProfile } from "@kindergarten/contracts";
import { controlApi } from "../api/control-api.js";
import { addMention, mentionInputs, mentionQuery, removeMentionTrigger } from "../components/composer/composer-mention.js";
import { ReasoningProfileSelect } from "../components/reasoning/ReasoningProfileSelect.js";
import { formatContextWindow, joinMetadata } from "../components/tokens/token-format.js";
import { availableReasoningProfiles, profileLabel } from "../reasoning/reasoning-config.js";
import { ProductNav } from "./ProductNav.js";
import { ErrorState, LoadingState } from "./LoadState.js";
import { useResource } from "./use-resource.js";
import { publicSkillUrl } from "../skills/public-skill-url.js";

export const websitePrompt = `请先把以下 Skills 安装到当前 Agent 并自动启用，全部就绪后再开始任务：
${publicSkillUrl("website-design-fast")}

请制作一个气泡水网站，风格是幼稚可爱清新活泼，气泡水有四种口味：葡萄、橙子、海盐、青柠。首屏的大slogan是“快来一起做汽水课间操！”，背景需要有淡化不喧宾夺主的动效。然后后面几屏需要展示不同口味气泡水瓶的介绍，需要气泡水瓶内的水随鼠标反馈可以做液体运动。还需要展示网页互动小游戏，吸引学生群体。`;

export const pptPrompt = `运用 ${publicSkillUrl("pptx")} skill

帮我给旺仔QQ糖只做一篇全口味宣传的PPT，要从同年回忆小故事、口味联想、情绪价值和针对受众群体喜好的宣传活动。`;

/** 渲染「HomePage」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function HomePage() {
  const load = useCallback(/** 缓存「load」的派生计算，依赖变化时重新生成以避免陈旧闭包。 */
async () => {
    const [models, agents, sessions] = await Promise.all([controlApi.models(), controlApi.agents(), controlApi.sessions()]);
    return { models: models.items, agents: agents.items, sessions: sessions.items };
  }, []);
  const { state, retry } = useResource(load);
  if (state.phase === "loading") return <Page><LoadingState label="正在读取模型、Agent 与会话" /></Page>;
  if (state.phase === "error") return <Page><ErrorState {...state} retry={retry} /></Page>;
  return <HomeReady {...state.data} />;
}

/** 渲染「HomeReady」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function HomeReady({ models, agents, sessions }: { models: ModelStudentSummary[]; agents: AgentRecord[]; sessions: Awaited<ReturnType<typeof controlApi.sessions>>["items"] }) {
  const readyModels = models.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.status === "ready");
  const [prompt, setPrompt] = useState("");
  const [mentions, setMentions] = useState<ArtifactRecord[]>([]);
  const [mentionOptions, setMentionOptions] = useState<ArtifactRecord[]>([]);
  const [activeMention, setActiveMention] = useState(0);
  const [mentionSearching, setMentionSearching] = useState(false);
  const [mentionError, setMentionError] = useState<string | null>(null);
  const [modelId, setModelId] = useState(/** 执行「[modelId, setModelId]」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => selectInitialModelStudentId(readyModels, location.search));
  const [agentId, setAgentId] = useState(agents[0]?.agentId ?? "");
  const [reasoningProfile, setReasoningProfile] = useState<ReasoningProfile>("auto");
  const modelPicker = useRef<HTMLDetailsElement>(null);
  const agentPicker = useRef<HTMLDetailsElement>(null);
  const model = models.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.modelStudentId === modelId) ?? models[0];
  const agent = agents.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.agentId === agentId) ?? agents[0];
  const reasoningProfiles = useMemo(/** 缓存「reasoningProfiles」的派生计算，依赖变化时重新生成以避免陈旧闭包。 */
() => availableReasoningProfiles(model?.supports.reasoning), [model]);
  useEffect(/** 同步组件生命周期内的外部状态，并在清理阶段释放订阅或临时资源。 */
() => {
    if (reasoningProfiles.length === 0 || !reasoningProfiles.includes(reasoningProfile)) setReasoningProfile("auto");
  }, [modelId, reasoningProfile, reasoningProfiles]);
  const query = mentionQuery(prompt);
  useEffect(/** 同步组件生命周期内的外部状态，并在清理阶段释放订阅或临时资源。 */
() => {
    if (query === null) { setMentionOptions([]); setMentionSearching(false); setMentionError(null); return; }
    let disposed = false;
    const timer = window.setTimeout(/** 执行受生命周期约束的定时任务，调用方负责在结束时取消句柄。 */
() => {
      setMentionSearching(true);
      setMentionError(null);
      void controlApi.artifacts(query, "active").then(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
(value) => {
        if (disposed) return;
        setMentionOptions(value.items.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => !mentions.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(mention) => mention.artifactId === item.artifactId)).slice(0, 8));
        setActiveMention(0);
      }).catch(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
(error: unknown) => {
        if (!disposed) {
          console.error("主页搜索 Artifact 失败", error);
          setMentionOptions([]);
          setMentionError(error instanceof Error ? error.message : "Artifact 列表读取失败");
        }
      }).finally(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => { if (!disposed) setMentionSearching(false); });
    }, 120);
    return /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */ () => { disposed = true; window.clearTimeout(timer); };
  }, [mentions, query]);
  /** 执行「submit」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async function submit(event: FormEvent) {
    event.preventDefault();
    if (!prompt.trim() || !modelId || !agentId) return;
    const launch = await controlApi.createSessionLaunch({
      promptText: prompt.trim(), modelStudentId: modelId, agentId,
      ...(mentions.length > 0 ? { artifactMentions: mentionInputs(mentions) } : {}),
      ...(reasoningProfile === "auto" ? {} : { reasoningProfileOverride: reasoningProfile }),
    });
    location.href = `/session?launchId=${encodeURIComponent(launch.launchId)}`;
  }
  /** 执行「selectMention」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function selectMention(artifact: ArtifactRecord) {
    setMentions(/** 执行「selectMention」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(current) => addMention(current, artifact));
    setPrompt(/** 执行「selectMention」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(current) => removeMentionTrigger(current));
    setMentionOptions([]);
    setMentionError(null);
  }
  /** 执行「mentionKeyDown」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function mentionKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (query === null || mentionOptions.length === 0) return;
    if (event.key === "ArrowDown") { event.preventDefault(); setActiveMention(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(value) => (value + 1) % mentionOptions.length); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); setActiveMention(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(value) => (value - 1 + mentionOptions.length) % mentionOptions.length); return; }
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      const item = mentionOptions[activeMention];
      if (item) selectMention(item);
    }
  }
  return <Page><section className="product-home-main">
    <header className="product-hero">
      <div className="product-model-controls"><details className="product-picker" ref={modelPicker}><summary><span><GraduationCap size={20} /></span><div><small>当前模型学生</small><strong>{model?.displayName ?? "没有可用模型"}</strong><em>{model ? joinMetadata([model.model, model.providerKind, formatContextWindow(model.contextWindowTokens)]) : "Remote 未配置"}</em></div><b>{model?.status === "ready" ? "可用" : "不可用"}</b><ChevronDown size={15} /></summary>
          <div>{models.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => <button disabled={item.status !== "ready"} key={item.modelStudentId} type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => { setModelId(item.modelStudentId); modelPicker.current?.removeAttribute("open"); }}><span><GraduationCap size={14} /></span><div><strong>{item.displayName}</strong><small>{joinMetadata([formatContextWindow(item.contextWindowTokens), item.model, item.status === "ready" ? "可用" : item.statusMessage ?? "不可用"])}</small></div>{item.modelStudentId === modelId && <Check size={13} />}</button>)}</div>
        </details><a className="product-model-admission-link" href="/models/new"><UserPlus size={15} />新模型入园</a></div>
      <h1>今天想让模型学习什么？</h1><p>选择一个真实 Agent，生成 HTML 或 PPTX，并把已发布产物继续复用。</p>
      <HomeCapabilities onSelectPptx={/** 处理「onSelectPptx」事件，校验归属后再推进状态且避免重复提交。 */
() => setPrompt(pptPrompt)} onSelectWebsite={/** 处理「onSelectWebsite」事件，校验归属后再推进状态且避免重复提交。 */
() => setPrompt(websitePrompt)} />
      <form className="product-home-composer" onSubmit={/** 处理「onSubmit」事件，校验归属后再推进状态且避免重复提交。 */
(event) => void submit(event)}>
        {mentions.length > 0 && <div className="composer-mention-tags" aria-label="已引用产物">{mentions.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(artifact) => <span className="composer-mention-tag" key={artifact.artifactId} title={`${artifact.displayName} · ${artifact.artifactId}`}>
          {artifact.kind === "html_bundle" ? <FileCode2 size={12} /> : artifact.primary.mimeType.startsWith("image/") ? <FileArchive size={12} /> : <FileText size={12} />}
          <strong>{artifact.displayName}</strong><small>{artifact.artifactId.slice(-6)}</small>
          <button aria-label={`移除 ${artifact.displayName}`} type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => setMentions(/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
(current) => current.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.artifactId !== artifact.artifactId))}><X size={11} /></button>
        </span>)}</div>}
        <div className="product-home-prompt-wrap">
          <textarea aria-label="给 ModelStudent 发送消息" rows={3} placeholder="给 ModelStudent 发送消息…" value={prompt} onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(event) => setPrompt(event.target.value)} onKeyDown={mentionKeyDown} />
          {query !== null && <div className="composer-mention-menu" role="listbox" aria-label="选择已有产物">
            <header><Search size={12} /><span>{mentionSearching ? "正在搜索" : "引用我的产物"}</span></header>
            {mentionError ? <p role="alert">读取失败：{mentionError}</p> : !mentionSearching && mentionOptions.length === 0 ? <p>没有可引用的 Artifact</p> : mentionOptions.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(artifact, index) => <button
              aria-selected={index === activeMention}
              className={index === activeMention ? "active" : ""}
              key={artifact.artifactId}
              role="option"
              type="button"
              onMouseDown={/** 处理「onMouseDown」事件，校验归属后再推进状态且避免重复提交。 */
(event) => event.preventDefault()}
              onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => selectMention(artifact)}
            ><span><strong>{artifact.displayName}</strong><small>{artifact.kind === "html_bundle" ? "HTML Bundle" : artifact.primary.mimeType} · {artifact.artifactId.slice(-8)}</small></span></button>)}
          </div>}
        </div>
        <footer><div className="product-home-settings"><details className="product-agent-picker" ref={agentPicker}><summary><Bot size={13} /><strong>{agent?.name ?? "没有 Agent"}</strong><ChevronDown size={13} /></summary><div>{agents.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => <button type="button" key={item.agentId} onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => { setAgentId(item.agentId); agentPicker.current?.removeAttribute("open"); }}><Bot size={13} /><span><strong>{item.name}</strong><small>{item.description ?? "未填写说明"}</small></span>{item.agentId === agentId && <Check size={12} />}</button>)}</div></details>{reasoningProfiles.length > 1 && <ReasoningProfileSelect {...(model ? { capability: model.supports.reasoning } : {})} choices={reasoningProfiles.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(profile) => ({ profile, name: profileLabel(profile, model?.supports.reasoning) }))} label="新会话思考控制" onChange={setReasoningProfile} value={reasoningProfile} />}</div><span>创建后，Agent 与模型固定在该会话中</span><button aria-label="发送" disabled={!prompt.trim() || !modelId || !agentId} type="submit"><ArrowUp size={16} /></button></footer>
      </form>
    </header>
    <section className="product-recent"><header><span>ADMIN · RECENT SESSIONS</span><h2>最近会话</h2></header>{sessions.length === 0 ? <div className="product-empty"><strong>还没有会话</strong><p>从上方输入一个任务即可开始。</p></div> : <div>{sessions.slice(0, 6).map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(session) => <a href={`/sessions/${encodeURIComponent(session.sessionId)}`} key={session.sessionId}><span><strong>{session.title}</strong><small>{session.preview || "暂无消息"}</small></span><time>{formatDate(session.updatedAt)}</time></a>)}</div>}</section>
  </section></Page>;
}

/** 渲染「HomeCapabilities」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function HomeCapabilities({ onSelectPptx, onSelectWebsite }: { onSelectPptx: () => void; onSelectWebsite: () => void }) {
  return <div className="product-capability-cards">
    <button type="button" onClick={onSelectWebsite}><Code2 size={17} /><span><strong>网站开发</strong><small>显式安装网页设计 Skills 后生成 HTML</small></span></button>
    <button type="button" onClick={onSelectPptx}><Presentation size={17} /><span><strong>PPT 制作</strong><small>使用 PPTX Skill 生成可预览演示文稿</small></span></button>
    {/* 上下文实验保留实现；功能调研期间只展示状态，不开放入口。 */}
    <button aria-label="模型上下文实验（功能调研中）" disabled type="button"><FlaskConical size={17} /><span><strong>模型上下文实验</strong><small>功能调研中</small></span></button>
  </div>;
}

/** 渲染「Page」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function Page({ children }: { children: React.ReactNode }) { return <main className="product-page"><ProductNav active="home" />{children}</main>; }
/** 执行「formatDate」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }

/** 由规范字段生成稳定的「selectInitialModelStudentId」标识，供索引精确定位且不保留原始大对象。 */
export function selectInitialModelStudentId(models: ModelStudentSummary[], search: string): string {
  const requested = new URLSearchParams(search).get("modelStudentId");
  return models.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.modelStudentId === requested)?.modelStudentId ?? models[0]?.modelStudentId ?? "";
}
