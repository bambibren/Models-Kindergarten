import { PlugZap, UserX } from "lucide-react";
import type { ConnectionState } from "../../store/app-store.js";
import { deletedAgentMessage } from "../../session/session-identity.js";

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

/** Agent 删除不影响历史回放，但当前 Session 不能再发起新的 Turn。 */
export function ComposerAgentMissingNotice() {
  return <div className="composer-availability-notice agent-missing" role="alert">
    <UserX size={15} />
    <span>{deletedAgentMessage}</span>
  </div>;
}
