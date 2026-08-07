import { ChevronDown, Circle } from "lucide-react";
import type { ConnectionState } from "../../store/app-store.js";

export function ChatHeader({ connection }: { connection: ConnectionState }) {
  return <header className="chat-header"><button type="button" className="model-switcher">ModelStudent <ChevronDown size={14} /></button><div className={`connection-state ${connection.phase}`}><Circle size={7} fill="currentColor" />{connection.phase === "connected" ? "ACP 已连接" : connection.phase === "connecting" ? "连接中" : "已断开"}</div></header>;
}
