import { ArrowUp, Bot, Check, ChevronDown, Code2, FlaskConical, GraduationCap, Plus, Presentation } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { ReasoningProfile } from "@kindergarten/contracts";
import { demoAgentStrategies, demoModelStudents, demoSessions } from "../demo-data.js";
import { loadSavedAgents, mergeAgentStrategies } from "../agent-editor/agent-storage.js";
import { isWebsiteDevelopmentRequest, websiteDevelopmentPrompt, websiteSkillSources } from "../skills/skill-install-state.js";
import { DemoTopNav } from "../shared/DemoTopNav.js";
import { ReasoningProfileSelect } from "../../components/reasoning/ReasoningProfileSelect.js";
import { saveDemoSessionReasoning } from "../reasoning/demo-reasoning-state.js";
import { publicSkillUrl } from "../../skills/public-skill-url.js";
import "./model-home.css";

const prompts = {
  site: websiteDevelopmentPrompt,
  pptx: `运用 ${publicSkillUrl("pptx")} skill

帮我给旺仔QQ糖只做一篇全口味宣传的PPT，要从同年回忆小故事、口味联想、情绪价值和针对受众群体喜好的宣传活动。`,
};

/** 渲染「ModelHomePage」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function ModelHomePage() {
  const [prompt, setPrompt] = useState("");
  const [expanded, setExpanded] = useState(false);
  const models = demoModelStudents;
  const [selectedModelId, setSelectedModelId] = useState(/** 执行「[selectedModelId, setSelectedModelId]」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => {
    const saved = sessionStorage.getItem("mk-demo-model-student");
    return models.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(model) => model.id === saved) ? saved! : models[0]?.id ?? "";
  });
  const [agents] = useState(/** 执行「[agents]」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => mergeAgentStrategies(loadSavedAgents(sessionStorage), demoAgentStrategies));
  const [selectedAgentId, setSelectedAgentId] = useState(agents[0]?.id ?? "");
  const [reasoningProfile, setReasoningProfile] = useState<ReasoningProfile>("auto");
  const modelPickerRef = useRef<HTMLDetailsElement>(null);
  const agentPickerRef = useRef<HTMLDetailsElement>(null);
  const selectedModel = models.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(model) => model.id === selectedModelId) ?? models[0];
  const selectedAgent = agents.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(agent) => agent.id === selectedAgentId) ?? agents[0];
  const reasoningCapability = selectedModel?.capabilities.reasoningControl;
  const websiteRequest = isWebsiteDevelopmentRequest(prompt);

  useEffect(/** 同步组件生命周期内的外部状态，并在清理阶段释放订阅或临时资源。 */
() => {
    if (!reasoningCapability?.adjustable
      || (reasoningProfile !== "auto" && !reasoningCapability.supportedProfiles.includes(reasoningProfile))) {
      setReasoningProfile("auto");
    }
  }, [reasoningCapability, reasoningProfile]);

  /** 执行「submit」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function submit(event: FormEvent) {
    event.preventDefault();
    if (!prompt.trim()) return;
    sessionStorage.setItem("mk-demo-home-prompt", prompt.trim());
    if (selectedModel) sessionStorage.setItem("mk-demo-model-student", selectedModel.id);
    if (selectedAgent) sessionStorage.setItem("mk-demo-agent", selectedAgent.id);
    const launchReasoningProfile = reasoningCapability?.adjustable
      && (reasoningProfile === "auto" || reasoningCapability.supportedProfiles.includes(reasoningProfile))
      ? reasoningProfile
      : "auto";
    saveDemoSessionReasoning(sessionStorage, "demo-new-session", launchReasoningProfile);
    if (isWebsiteDevelopmentRequest(prompt)) sessionStorage.setItem("mk-demo-home-flow", "website-development");
    else sessionStorage.removeItem("mk-demo-home-flow");
    location.href = "/demo/session?draft=home-prompt";
  }

  return <main className="mk-demo-app mk-model-home">
    <DemoTopNav active="home" compactHome />
    <section className="mk-model-home-main">
      <header className="mk-model-home-hero">
        <div className="mk-model-hero-controls">
          <details className="mk-model-student-picker" ref={modelPickerRef}>
            <summary>
              <span className="mk-model-home-mark"><GraduationCap size={21} /></span>
              <div><small>当前模型学生</small><strong>{selectedModel?.name}</strong><em>{selectedModel?.model} · {selectedModel?.provider}</em></div>
              <span className="mk-model-current-score">{modelScoreLabel(selectedModel?.score)}</span>
              <ChevronDown size={15} />
            </summary>
            <div className="mk-model-student-menu">
              <header><strong>选择 ModelStudent</strong><small>模型就是幼儿园的学生</small></header>
              {models.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(model) => <button key={model.id} type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => { setSelectedModelId(model.id); sessionStorage.setItem("mk-demo-model-student", model.id); modelPickerRef.current?.removeAttribute("open"); }}>
                <span><GraduationCap size={14} /></span><div><strong>{model.name}</strong><small>{model.model} · {model.state}</small></div><em>{modelScoreLabel(model.score)}</em>{model.id === selectedModelId && <Check size={13} />}
              </button>)}
            </div>
          </details>
        </div>
        <h1>今天想让模型学习什么？</h1>
        <p>从一个具体任务开始，生成 HTML 或 PPTX 产物并继续复用。</p>
        <div className="mk-model-capabilities" aria-label="学习方向">
          <button className={websiteRequest ? "active" : ""} type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => setPrompt(prompts.site)}><Code2 size={16} /><span><strong>网站开发</strong><small>显式安装网页设计 Skills 后生成 HTML</small></span></button>
          <button type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => setPrompt(prompts.pptx)}><Presentation size={16} /><span><strong>PPT 制作</strong><small>使用 PPTX Skill 生成可预览演示文稿</small></span></button>
          {/* 上下文实验保留实现；功能调研期间只展示状态，不开放入口。 */}
          <button aria-label="模型上下文实验（功能调研中）" disabled type="button"><FlaskConical size={16} /><span><strong>模型上下文实验</strong><small>功能调研中</small></span></button>
        </div>
        <form className="mk-model-home-composer" onSubmit={submit}>
          <textarea aria-label="给 ModelStudent 发送消息" className={websiteRequest ? "website-request" : ""} onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(event) => setPrompt(event.target.value)} placeholder="给 ModelStudent 发送消息…" rows={websiteRequest ? 7 : 2} value={prompt} />
          <div className="mk-model-composer-footer">
            <details className="mk-agent-picker" ref={agentPickerRef}>
              <summary><Bot size={13} /><strong>{selectedAgent?.name ?? "选择 Agent"}</strong><ChevronDown size={13} /></summary>
              <div>{agents.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(agent) => <button className={agent.id === selectedAgentId ? "selected" : ""} key={agent.id} type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => { setSelectedAgentId(agent.id); agentPickerRef.current?.removeAttribute("open"); }}><span><Bot size={13} /></span><div><strong>{agent.name}</strong><small>{agent.description}</small></div>{agent.id === selectedAgentId && <Check size={12} />}</button>)}<a href="/demo/agent-editor?mode=create"><Plus size={13} />添加 Agent</a></div>
            </details>
            {reasoningCapability?.adjustable && <ReasoningProfileSelect
              capability={reasoningCapability}
              choices={(["auto", ...reasoningCapability.supportedProfiles] as ReasoningProfile[]).map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(profile) => ({ profile }))}
              className="mk-demo-home-reasoning"
              label="Demo 新会话思考强度"
              onChange={setReasoningProfile}
              value={reasoningProfile}
            />}
            <span>本地模型可能会出错，请核对重要信息</span>
          </div>
          <button aria-label="发送" disabled={!prompt.trim()} type="submit"><ArrowUp size={16} /></button>
        </form>
      </header>

      <section className="mk-model-history">
        <header><div><span>ADMIN · RECENT SESSIONS</span><h2>最近会话</h2></div><button type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => setExpanded(/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
(value) => !value)}>{expanded ? "收起" : "查看更多"}</button></header>
        <div className="mk-model-history-list">
          {demoSessions.slice(0, expanded ? 6 : 3).map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(session) => <a href={`/demo/session?sessionId=${session.id}`} key={session.id}>
            <span><strong>{session.title}</strong><small>{session.preview}</small></span><time>{session.updatedAt}</time>
          </a>)}
        </div>
      </section>
    </section>
  </main>;
}

/** 执行「modelScoreLabel」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function modelScoreLabel(score: number | null | undefined): string {
  return typeof score === "number" ? `${score} 分` : "待评测";
}
