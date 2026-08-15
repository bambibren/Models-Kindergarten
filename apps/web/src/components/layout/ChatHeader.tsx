import { Bot, Circle } from "lucide-react";
import type { ConnectionState } from "../../store/app-store.js";

export function ChatHeader({ connection, identity }: { connection: ConnectionState; identity: { agentName: string; modelName: string } }) {
  return <header className="chat-header"><div className="session-identity"><Bot size={14} /><strong>{identity.agentName}</strong><span>·</span><small>{identity.modelName}</small></div><div className={`connection-state ${connection.phase}`}><Circle size={7} fill="currentColor" />{connection.phase === "connected" ? "ACP 已连接" : connection.phase === "connecting" ? "连接中" : "已断开"}</div></header>;
}
