import type { SessionInfo } from "@agentclientprotocol/sdk";
import { GraduationCap, MessageSquare, PanelLeftClose, Plus } from "lucide-react";

/** 渲染「SessionSidebar」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function SessionSidebar({ sessions, activeId, disabled, onCreate, onSelect }: { sessions: SessionInfo[]; activeId: string | null; disabled: boolean; onCreate: () => void; onSelect: (session: SessionInfo) => void }) {
  return <aside className="sidebar">
    <a className="sidebar-brand" href="/"><span><GraduationCap size={20} /></span><div><strong>模型幼儿园</strong><small>Models KinderGarten</small></div><PanelLeftClose className="sidebar-close" size={17} /></a>
    <button className="new-chat" type="button" disabled={disabled} onClick={onCreate}><Plus size={17} />新对话</button>
    <div className="sidebar-label">会话</div>
    <nav className="session-list" aria-label="历史会话">{sessions.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(session) => <button className={session.sessionId === activeId ? "active" : ""} type="button" key={session.sessionId} disabled={disabled} onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => onSelect(session)}><MessageSquare size={14} /><span>{session.title || "新对话"}</span><small>{formatTime(session.updatedAt)}</small></button>)}</nav>
  </aside>;
}

/** 执行「formatTime」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function formatTime(value?: string | null) { if (!value) return ""; return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(new Date(value)); }
