import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, MessageSquare, PanelLeftClose, PanelLeftOpen, Plus, UserRound } from "lucide-react";
import type { ReasoningProfile } from "@kindergarten/contracts";
import { demoAgentStrategies, demoArtifacts, demoChatStream, demoMcpInstallations, demoModelStudents, demoSessions } from "../demo-data.js";
import type { DemoArtifact, DemoStreamItem } from "../demo-types.js";
import { loadSavedAgents, mergeAgentStrategies, saveAgent } from "../agent-editor/agent-storage.js";
import { boundMcpIds, loadRemovedMcpIds, loadSavedMcps, mergeMcpInstallations, projectStreamForAgent } from "../mcp/mcp-demo-state.js";
import { bindSkillsToAgent, isWebsiteDevelopmentRequest, skillInstallProgress, websiteSkillSources } from "../skills/skill-install-state.js";
import { useDemoSkillInstall } from "../skills/use-demo-skill-install.js";
import { DemoChatStream } from "../shared/DemoChatStream.js";
import { DemoTopNav } from "../shared/DemoTopNav.js";
import { ReasoningProfileSelect } from "../../components/reasoning/ReasoningProfileSelect.js";
import { loadDemoSessionReasoning, saveDemoSessionReasoning } from "../reasoning/demo-reasoning-state.js";
import { ArtifactPanel } from "./ArtifactPanel.js";
import { ContextWindowUsageIndicator } from "../../components/composer/ContextWindowUsageIndicator.js";
import { SkillInstallBanner } from "./SkillInstallBanner.js";
import { clampArtifactWidth, defaultArtifactWidth } from "./split-pane.js";
import "./session-demo.css";

/** 渲染「SessionDemoPage」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function SessionDemoPage() {
  const query = useMemo(/** 缓存「query」的派生计算，依赖变化时重新生成以避免陈旧闭包。 */
() => new URLSearchParams(location.search), []);
  const draftPrompt = query.get("draft") === "home-prompt" ? sessionStorage.getItem("mk-demo-home-prompt") : null;
  const selectedModelId = sessionStorage.getItem("mk-demo-model-student");
  const initialAgentId = sessionStorage.getItem("mk-demo-agent") ?? "agent-default";
  const websiteFlow = Boolean(draftPrompt && sessionStorage.getItem("mk-demo-home-flow") === "website-development" && isWebsiteDevelopmentRequest(draftPrompt));
  const selectedModel = demoModelStudents.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(model) => model.id === selectedModelId) ?? demoModelStudents[0];
  const [agents] = useState(/** 执行「[agents]」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => mergeAgentStrategies(loadSavedAgents(sessionStorage), demoAgentStrategies));
  const [installations] = useState(/** 执行「[installations]」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => mergeMcpInstallations(loadSavedMcps(sessionStorage), demoMcpInstallations, loadRemovedMcpIds(sessionStorage)));
  const selectedAgent = agents.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(agent) => agent.id === initialAgentId) ?? agents[0] ?? demoAgentStrategies[0];
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [activeSession, setActiveSession] = useState(query.get("draft") ? "demo-new-session" : query.get("sessionId") ?? demoSessions[0]?.id ?? "");
  const [reasoningProfile, setReasoningProfile] = useState<ReasoningProfile>(/** 执行「[reasoningProfile, setReasoningProfile]」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => loadDemoSessionReasoning(sessionStorage, query.get("draft") ? "demo-new-session" : query.get("sessionId") ?? demoSessions[0]?.id ?? ""));
  const [artifact, setArtifact] = useState<DemoArtifact | null>(null);
  const [artifactWidth, setArtifactWidth] = useState(520);
  const [isResizing, setIsResizing] = useState(false);
  const [narrowView, setNarrowView] = useState<"artifact" | "chat">("artifact");
  const [websiteReady, setWebsiteReady] = useState(false);
  const [showInstallBanner, setShowInstallBanner] = useState(websiteFlow);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const installStarted = useRef(false);
  const { batch: installBatch, start: startInstall } = useDemoSkillInstall(/** 执行「{ batch: installBatch, start: startInstall }」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(records) => {
    if (selectedAgent) saveAgent(sessionStorage, bindSkillsToAgent(selectedAgent, records.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(record) => record.name)));
    setWebsiteReady(true);
    window.setTimeout(/** 执行受生命周期约束的定时任务，调用方负责在结束时取消句柄。 */
() => setShowInstallBanner(false), 1100);
  });

  useEffect(/** 同步组件生命周期内的外部状态，并在清理阶段释放订阅或临时资源。 */
() => {
    if (!websiteFlow || installStarted.current) return;
    installStarted.current = true;
    startInstall(websiteSkillSources);
  }, [startInstall, websiteFlow]);

  /** 执行「selectSession」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function selectSession(sessionId: string) {
    setActiveSession(sessionId);
    setReasoningProfile(loadDemoSessionReasoning(sessionStorage, sessionId));
  }

  /** 执行「changeReasoning」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function changeReasoning(profile: ReasoningProfile) {
    saveDemoSessionReasoning(sessionStorage, activeSession, profile);
    setReasoningProfile(profile);
  }

  /** 执行「openArtifact」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function openArtifact(next: DemoArtifact) {
    const containerWidth = workspaceRef.current?.clientWidth;
    if (containerWidth) setArtifactWidth(defaultArtifactWidth(containerWidth));
    setArtifact(next);
    setNarrowView("artifact");
  }

  /** 执行「startResize」主流程，传播取消与失败并在结束时清理临时资源。 */
function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    const workspace = workspaceRef.current;
    if (!workspace || event.button !== 0) return;
    event.preventDefault();
    const pointerId = event.pointerId;
    const rect = workspace.getBoundingClientRect();
    const move = /** 执行「move」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      setArtifactWidth(clampArtifactWidth(pointer.clientX - rect.left, rect.width));
    };
    const stop = /** 执行「stop」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      setIsResizing(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    setIsResizing(true);
  }

  const workspaceStyle = { "--artifact-width": `${artifactWidth}px` } as CSSProperties;
  const baseChatItems = useMemo(/** 缓存「baseChatItems」的派生计算，依赖变化时重新生成以避免陈旧闭包。 */
() => {
    if (!draftPrompt) return demoChatStream;
    if (!websiteFlow) return demoChatStream.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.type === "user" ? { ...item, text: draftPrompt } : item);
    return websiteDevelopmentStream(draftPrompt, websiteReady, installBatch ? skillInstallProgress(installBatch).phase : "queued");
  }, [draftPrompt, installBatch, websiteFlow, websiteReady]);
  const chatItems = useMemo(/** 缓存「chatItems」的派生计算，依赖变化时重新生成以避免陈旧闭包。 */
() => selectedAgent ? projectStreamForAgent(baseChatItems, selectedAgent, installations) : baseChatItems, [baseChatItems, installations, selectedAgent]);
  const readyMcpCount = selectedAgent ? installations.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(mcp) => mcp.state === "ready" && boundMcpIds(selectedAgent).includes(mcp.id)).length : 0;
  const sessionTitle = websiteFlow ? "设计 Model Kindergarten 课程网站" : demoSessions.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(session) => session.id === activeSession)?.title ?? "新对话";
  return <main className={`mk-demo-app mk-session-demo ${railCollapsed ? "rail-collapsed" : ""}`}>
    <DemoTopNav active="session" />
    <div className="mk-session-shell">
      <aside className="mk-session-rail">
        <header>
          {!railCollapsed && <span><strong>Admin 的会话</strong><small>写死数据 Demo</small></span>}
          <button aria-label={railCollapsed ? "展开会话列表" : "收起会话列表"} type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => setRailCollapsed(/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
(value) => !value)}>{railCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</button>
        </header>
        <button className="mk-session-new" type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => selectSession("demo-new-session")}><Plus size={16} />{!railCollapsed && <span>新对话</span>}</button>
        <nav aria-label="Admin 历史会话">
          {demoSessions.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(session) => <button className={activeSession === session.id ? "active" : ""} key={session.id} title={session.title} type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => selectSession(session.id)}>
            <MessageSquare size={14} />{!railCollapsed && <><span>{session.title}</span><small>{session.updatedAt}</small></>}
          </button>)}
        </nav>
        <footer><span><UserRound size={15} /></span>{!railCollapsed && <div><strong>Admin</strong><small>本地 Demo 账号</small></div>}</footer>
      </aside>

      <section className={`mk-session-main ${artifact ? "has-artifact" : ""}`}>
        {artifact && <div className="mk-session-narrow-switch" aria-label="窄屏视图">
          <button className={narrowView === "artifact" ? "active" : ""} type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => setNarrowView("artifact")}>产物</button>
          <button className={narrowView === "chat" ? "active" : ""} type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => setNarrowView("chat")}>聊天</button>
        </div>}
        <div className={`mk-session-workspace narrow-${narrowView} ${isResizing ? "is-resizing" : ""}`} ref={workspaceRef} style={workspaceStyle}>
          {artifact && <ArtifactPanel artifact={artifact} onClose={/** 处理「onClose」事件，校验归属后再推进状态且避免重复提交。 */
() => setArtifact(null)} />}
          {artifact && <div
            aria-label="调整产物与聊天宽度"
            aria-orientation="vertical"
            className="mk-session-resizer"
            onPointerDown={startResize}
            role="separator"
          ><ChevronLeft size={10} /><ChevronRight size={10} /></div>}
          <section className="mk-session-chat">
            <header><div><strong>{sessionTitle}</strong><small>{selectedModel?.model ?? "qwen3:8b"} · {readyMcpCount} 个 MCP 已授权 · UI Demo</small></div><div className="mk-session-agent-identity"><span>Agent</span><strong>{selectedAgent?.name}</strong></div></header>
            <div className="mk-session-chat-scroll">
              <DemoChatStream artifacts={demoArtifacts} items={chatItems} onOpenArtifact={openArtifact} />
            </div>
            <div className="mk-session-composer-stack">
              {showInstallBanner && installBatch && <SkillInstallBanner batch={installBatch} />}
              <form className="mk-session-composer" onSubmit={/** 处理「onSubmit」事件，校验归属后再推进状态且避免重复提交。 */
(event) => event.preventDefault()}>
                <textarea aria-label="Demo 消息输入" disabled={Boolean(installBatch && !websiteReady)} placeholder={installBatch && !websiteReady ? "Skills 安装完成后可继续对话…" : "给 ModelStudent 发送消息…"} rows={1} />
                {selectedModel?.capabilities.reasoningControl.adjustable && <ReasoningProfileSelect
                  capability={selectedModel.capabilities.reasoningControl}
                  choices={(["auto", ...selectedModel.capabilities.reasoningControl.supportedProfiles] as ReasoningProfile[]).map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(profile) => ({ profile }))}
                  className="mk-demo-reasoning-select"
                  label="Demo 当前会话思考强度"
                  onChange={changeReasoning}
                  value={reasoningProfile}
                />}
                <div className="mk-session-actions">
                  <ContextWindowUsageIndicator demo value={{ afterTurnId: "demo-turn", estimatedTokens: 38_400, windowTokens: 128_000, remainingTokens: 89_600, percent: 30, ringPercent: 30, level: "normal" }} />
                  <button disabled aria-label="发送 Demo 消息" type="submit">发送</button>
                </div>
              </form>
            </div>
          </section>
        </div>
      </section>
    </div>
  </main>;
}

/** 执行「websiteDevelopmentStream」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function websiteDevelopmentStream(prompt: string, ready: boolean, phase: string): DemoStreamItem[] {
  const items: DemoStreamItem[] = [
    { id: "website-user", type: "user", text: prompt, inputTokens: Math.max(1, Math.round(prompt.length / 2.1)) },
    {
      id: "website-context",
      type: "context",
      turnId: "turn-website-demo",
      totalTokens: 766,
      items: [
        { id: "website-system", title: "系统提示", detail: "Agent 身份与文件沙箱边界", tokens: 286, raw: "{\n  \"role\": \"system\",\n  \"content\": \"你是 Model Kindergarten 的本地 Agent…\"\n}" },
        { id: "website-tools", title: "工具说明", detail: "ensure_agent_skills · write_file", tokens: 354, raw: "[\n  { \"name\": \"ensure_agent_skills\" },\n  { \"name\": \"write_file\" }\n]" },
        { id: "website-skills", title: "Skills 索引", detail: ready ? "3 个网站设计 Skills 已绑定" : "安装前的当前 Agent 索引", tokens: 126, raw: ready ? "[\"frontend-design\", \"design-brief\", \"impeccable-design-polish\"]" : "[\"sandbox-notes\", \"web-static\"]" },
      ],
    },
    { id: "website-thought-install", type: "thought", title: "已思考", text: "用户明确要求为当前 Agent 安装并启用三个公开 Skills。先完成受控安装，再继续网站设计。", tokens: 42 },
    {
      id: "website-install-tool",
      type: "tool",
      name: "ensure_agent_skills · 3 个来源",
      status: ready ? "completed" : "in_progress",
      input: JSON.stringify({ source_urls: websiteSkillSources }, null, 2),
      output: ready ? "三个 Skills 已安装到“我的 Skills”，并绑定到当前 Agent。" : `安装阶段：${phase}`,
      tokens: ready ? 84 : 0,
    },
  ];
  if (!ready) return items;
  return [...items,
    { id: "website-thought-design", type: "thought", title: "已思考", text: "设计 Skills 已就绪。接下来生成一页静态课程介绍站，并将 HTML 写入文件沙箱。", tokens: 68 },
    { id: "website-write-tool", type: "tool", name: "write_file · landing.html", status: "completed", input: "{ \"path\": \"landing.html\", \"format\": \"static-html\" }", output: "已在文件沙箱中写入 landing.html。", tokens: 58 },
    { id: "website-assistant", type: "assistant", markdown: "三个设计 Skills 已安装并启用到当前 Agent，静态课程介绍站也已生成。点击 **landing.html** 可在中间区域预览；本页只演示目标交互，不会调用真实安装器或模型。", outputTokens: 62, artifactIds: ["artifact-html"] },
  ];
}
