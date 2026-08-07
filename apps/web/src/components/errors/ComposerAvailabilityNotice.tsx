import { PlugZap } from "lucide-react";
import type { ConnectionState } from "../../store/app-store.js";

/** 服务可用性提示固定在输入区上方，不伪装成聊天消息。 */
export function ComposerAvailabilityNotice({ connection, onReconnect }: {
  connection: Extract<ConnectionState, { phase: "disconnected" }>;
  onReconnect: () => void;
}) {
  return <div className="composer-availability-notice" role="alert">
    <PlugZap size={15} />
    <span>{connection.message}</span>
    <button type="button" onClick={onReconnect}>重新连接</button>
  </div>;
}
