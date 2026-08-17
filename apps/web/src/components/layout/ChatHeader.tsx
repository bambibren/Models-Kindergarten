import { Bot, Circle } from "lucide-react";
import type { ConnectionState } from "../../store/app-store.js";
import { formatContextWindow } from "../tokens/token-format.js";

export function ChatHeader({ connection, identity }: { connection: ConnectionState; identity: { agentName: string; modelName: string; contextWindowTokens?: number } }) {
  const contextWindow = formatContextWindow(identity.contextWindowTokens);
  return <header className="chat-header"><div className="session-identity"><Bot size={14} /><strong>{identity.agentName}</strong><span>·</span><small>{identity.modelName}</small>{contextWindow && <><span>·</span><small>{contextWindow}</small></>}</div><div className={`connection-state ${connection.phase}`}><Circle size={7} fill="currentColor" />{connection.phase === "connected" ? "ACP 已连接" : connection.phase === "connecting" ? "连接中" : "已断开"}</div></header>;
}
