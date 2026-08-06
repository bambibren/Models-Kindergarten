import { ShieldCheck, Sparkles } from "lucide-react";
import { useState } from "react";
import type * as acp from "@agentclientprotocol/sdk";
import type { PendingInteraction } from "../../store/app-store.js";

interface Props { interaction: PendingInteraction; queued: number; onResolve: (interaction: PendingInteraction, value: acp.RequestPermissionResponse | acp.CreateElicitationResponse) => void; }

/** 当前等待用户处理的 ACP reverse request；固定在 Composer 上方，不属于聊天历史。 */
export function InteractionPendingPanel({ interaction, queued, onResolve }: Props) {
  if (interaction.kind === "permission") return <section className="interaction-pending-panel">
    <div className="interaction-heading"><span><ShieldCheck size={17} /></span><div><strong>需要你的许可</strong><p>{interaction.request.toolCall.title ?? "Agent 请求执行写入工具"}</p></div>{queued > 1 && <small>{queued - 1} 个待处理</small>}</div>
    <div className="interaction-actions"><button className="ghost-button" type="button" onClick={() => onResolve(interaction, { outcome: { outcome: "selected", optionId: "reject-once" } })}>拒绝</button><button className="primary-button" type="button" onClick={() => onResolve(interaction, { outcome: { outcome: "selected", optionId: "allow-once" } })}>允许本次</button></div>
  </section>;
  return <AskUserPanel interaction={interaction} queued={queued} onResolve={onResolve} />;
}

function AskUserPanel({ interaction, queued, onResolve }: Props & { interaction: Extract<PendingInteraction, { kind: "elicitation" }> }) {
  const [answer, setAnswer] = useState("");
  return <section className="interaction-pending-panel">
    <div className="interaction-heading"><span><Sparkles size={17} /></span><div><strong>Agent 正在等你回答</strong><p>{interaction.request.message}</p></div>{queued > 1 && <small>{queued - 1} 个待处理</small>}</div>
    <textarea aria-label="回答 Agent" autoFocus rows={2} value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="输入回答…" />
    <div className="interaction-actions"><button className="ghost-button" type="button" onClick={() => onResolve(interaction, { action: "cancel" })}>取消</button><button className="primary-button" type="button" disabled={!answer.trim()} onClick={() => onResolve(interaction, { action: "accept", content: { answer: answer.trim() } })}>提交回答</button></div>
  </section>;
}
