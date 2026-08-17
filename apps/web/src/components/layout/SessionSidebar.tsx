import type { SessionInfo } from "@agentclientprotocol/sdk";
import { GraduationCap, MessageSquare, PanelLeftClose, Plus } from "lucide-react";

export function SessionSidebar({ sessions, activeId, disabled, onCreate, onSelect }: { sessions: SessionInfo[]; activeId: string | null; disabled: boolean; onCreate: () => void; onSelect: (session: SessionInfo) => void }) {
  return <aside className="sidebar">
    <div className="sidebar-brand"><span><GraduationCap size={20} /></span><div><strong>Models Kindergarten</strong><small>Local ACP classroom</small></div><PanelLeftClose className="sidebar-close" size={17} /></div>
    <button className="new-chat" type="button" disabled={disabled} onClick={onCreate}><Plus size={17} />新对话</button>
    <div className="sidebar-label">会话</div>
    <nav className="session-list" aria-label="历史会话">{sessions.map((session) => <button className={session.sessionId === activeId ? "active" : ""} type="button" key={session.sessionId} disabled={disabled} onClick={() => onSelect(session)}><MessageSquare size={14} /><span>{session.title || "新对话"}</span><small>{formatTime(session.updatedAt)}</small></button>)}</nav>
  </aside>;
}

function formatTime(value?: string | null) { if (!value) return ""; return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(new Date(value)); }
