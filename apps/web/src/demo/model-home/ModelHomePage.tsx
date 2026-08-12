import { ArrowUp, BookOpenText, Bot, Check, ChevronDown, Code2, FlaskConical, GraduationCap, Plus } from "lucide-react";
import { useRef, useState } from "react";
import type { FormEvent } from "react";
import { demoAgentStrategies, demoModelStudents, demoSessions } from "../demo-data.js";
import { loadSavedAgents, mergeAgentStrategies } from "../agent-editor/agent-storage.js";
import { isWebsiteDevelopmentRequest, websiteDevelopmentPrompt, websiteSkillSources } from "../skills/skill-install-state.js";
import { DemoTopNav } from "../shared/DemoTopNav.js";
import "./model-home.css";

const prompts = {
  site: websiteDevelopmentPrompt,
};

export function ModelHomePage() {
  const [prompt, setPrompt] = useState("");
  const [expanded, setExpanded] = useState(false);
  const models = demoModelStudents;
  const [selectedModelId, setSelectedModelId] = useState(() => {
    const saved = sessionStorage.getItem("mk-demo-model-student");
    return models.some((model) => model.id === saved) ? saved! : models[0]?.id ?? "";
  });
  const [agents] = useState(() => mergeAgentStrategies(loadSavedAgents(sessionStorage), demoAgentStrategies));
  const [selectedAgentId, setSelectedAgentId] = useState(agents[0]?.id ?? "");
  const modelPickerRef = useRef<HTMLDetailsElement>(null);
  const agentPickerRef = useRef<HTMLDetailsElement>(null);
  const selectedModel = models.find((model) => model.id === selectedModelId) ?? models[0];
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? agents[0];
  const websiteRequest = isWebsiteDevelopmentRequest(prompt);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!prompt.trim()) return;
    sessionStorage.setItem("mk-demo-home-prompt", prompt.trim());
    if (selectedModel) sessionStorage.setItem("mk-demo-model-student", selectedModel.id);
    if (selectedAgent) sessionStorage.setItem("mk-demo-agent", selectedAgent.id);
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
              {models.map((model) => <button key={model.id} type="button" onClick={() => { setSelectedModelId(model.id); sessionStorage.setItem("mk-demo-model-student", model.id); modelPickerRef.current?.removeAttribute("open"); }}>
                <span><GraduationCap size={14} /></span><div><strong>{model.name}</strong><small>{model.model} · {model.state}</small></div><em>{modelScoreLabel(model.score)}</em>{model.id === selectedModelId && <Check size={13} />}
              </button>)}
            </div>
          </details>
        </div>
        <h1>今天想让模型学习什么？</h1>
        <p>从一个具体任务开始，或进入上下文实验比较不同策略。</p>
        <div className="mk-model-capabilities" aria-label="学习方向">
          <button aria-label="小说创作（功能调研中）" disabled type="button"><BookOpenText size={16} /><span><strong>小说创作</strong><small>功能调研中</small></span></button>
          <button className={websiteRequest ? "active" : ""} type="button" onClick={() => setPrompt(prompts.site)}><Code2 size={16} /><span><strong>网站开发</strong><small>安装 3 个 Skills 后生成 HTML</small></span></button>
          <a href="/demo/context-lab?mode=new"><FlaskConical size={16} /><span><strong>模型上下文实验</strong><small>比较 2–3 种输入策略</small></span></a>
        </div>
        <form className="mk-model-home-composer" onSubmit={submit}>
          <textarea aria-label="给 ModelStudent 发送消息" className={websiteRequest ? "website-request" : ""} onChange={(event) => setPrompt(event.target.value)} placeholder="给 ModelStudent 发送消息…" rows={websiteRequest ? 7 : 2} value={prompt} />
          <div className="mk-model-composer-footer">
            <details className="mk-agent-picker" ref={agentPickerRef}>
              <summary><Bot size={13} /><strong>{selectedAgent?.name ?? "选择 Agent"}</strong><ChevronDown size={13} /></summary>
              <div>{agents.map((agent) => <button className={agent.id === selectedAgentId ? "selected" : ""} key={agent.id} type="button" onClick={() => { setSelectedAgentId(agent.id); agentPickerRef.current?.removeAttribute("open"); }}><span><Bot size={13} /></span><div><strong>{agent.name}</strong><small>{agent.description}</small></div>{agent.id === selectedAgentId && <Check size={12} />}</button>)}<a href="/demo/agent-editor?mode=create"><Plus size={13} />添加 Agent</a></div>
            </details>
            <span>本地模型可能会出错，请核对重要信息</span>
          </div>
          <button aria-label="发送" disabled={!prompt.trim()} type="submit"><ArrowUp size={16} /></button>
        </form>
      </header>

      <section className="mk-model-history">
        <header><div><span>ADMIN · RECENT SESSIONS</span><h2>最近会话</h2></div><button type="button" onClick={() => setExpanded((value) => !value)}>{expanded ? "收起" : "查看更多"}</button></header>
        <div className="mk-model-history-list">
          {demoSessions.slice(0, expanded ? 6 : 3).map((session) => <a href={`/demo/session?sessionId=${session.id}`} key={session.id}>
            <span><strong>{session.title}</strong><small>{session.preview}</small></span><time>{session.updatedAt}</time>
          </a>)}
        </div>
      </section>
    </section>
  </main>;
}

function modelScoreLabel(score: number | null | undefined): string {
  return typeof score === "number" ? `${score} 分` : "待评测";
}
