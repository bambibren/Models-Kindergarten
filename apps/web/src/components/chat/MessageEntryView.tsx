import type { MessageEntry } from "../../chat/chat-types.js";
import { ContentRenderer } from "./ContentRenderer.js";
import { formatTokenCount } from "../tokens/token-format.js";
import { FileText } from "lucide-react";

export function MessageEntryView({ entry }: { entry: MessageEntry }) {
  if (entry.role === "user") return <article className="user-message">
    {entry.artifactMentions?.length ? <div className="message-mention-tags">{entry.artifactMentions.map((mention) => <span key={mention.artifactId} title={mention.uri}><FileText size={11} />{mention.displayName}<small>{mention.artifactId.slice(-6)}</small></span>)}</div> : null}
    <div className="user-bubble"><ContentRenderer content={entry.content} /></div>
    {entry.tokenEstimate && <small className="message-token-meta">输入约 {formatTokenCount(entry.tokenEstimate.estimatedTokens)} tokens</small>}
  </article>;
  return <article className="assistant-message">
    <div className="assistant-body">
      <ContentRenderer content={entry.content} streaming={entry.status === "streaming"} />
      {entry.status === "streaming" && <span className="stream-caret" aria-label="生成中" />}
    </div>
    {entry.tokenEstimate && <small className="message-token-meta assistant-token-meta">回答约 {formatTokenCount(entry.tokenEstimate.estimatedTokens)} tokens</small>}
  </article>;
}
