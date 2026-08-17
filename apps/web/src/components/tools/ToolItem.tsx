import * as Collapsible from "@radix-ui/react-collapsible";
import { Check, ChevronDown, CircleAlert, FilePenLine, FileSearch, LoaderCircle, MessageCircleQuestion, Wrench } from "lucide-react";
import type { ToolCallContent } from "@agentclientprotocol/sdk";
import type { ToolCallEntry } from "../../chat/chat-types.js";
import { useAutoDisclosure, type ActivityPhase } from "../../hooks/use-auto-disclosure.js";
import { ContentRenderer } from "../chat/ContentRenderer.js";
import { formatTokenCount } from "../tokens/token-format.js";

export function ToolItem({ entry }: { entry: ToolCallEntry }) {
  const phase = toolPhase(entry.status);
  const disclosure = useAutoDisclosure(phase);
  const artifacts = entry.content.flatMap((item) =>
    item.type === "content" && item.content.type === "resource_link" && item.content.uri.startsWith("mk-file://")
      ? [item.content]
      : []);
  return <Collapsible.Root className={`activity-item tool-item phase-${phase}`} open={disclosure.open} onOpenChange={disclosure.setOpen}>
    <Collapsible.Trigger className="activity-trigger">
      <span className="activity-icon">{toolIcon(entry, phase)}</span>
      <span className="activity-title">{entry.title}</span>
      <span className="activity-meta">
        <span className="activity-status">{phaseLabel(phase)}</span>
        {entry.tokenEstimate && <span className="activity-token">调用约 {formatTokenCount(entry.tokenEstimate.estimatedTokens)} tokens</span>}
      </span>
      <ChevronDown className="disclosure-chevron" size={15} />
    </Collapsible.Trigger>
    {artifacts.length > 0 && <div className="tool-artifact-actions">
      {artifacts.map((artifact) => <button key={artifact.uri} type="button" onClick={() => openArtifact(artifact.uri)}>
        预览 {artifact.title ?? artifact.name}
      </button>)}
    </div>}
    <Collapsible.Content className="activity-content tool-detail">
      {entry.rawInput !== undefined && <Detail label="输入"><JsonValue value={entry.rawInput} /></Detail>}
      {entry.content.map((item, index) => <ToolContent item={item} key={`${entry.toolCallId}:${index}`} />)}
      {entry.rawOutput !== undefined && <Detail label="输出"><JsonValue value={entry.rawOutput} /></Detail>}
    </Collapsible.Content>
  </Collapsible.Root>;
}

function openArtifact(uri: string): void {
  window.dispatchEvent(new CustomEvent("mk-open-file-reference", { detail: uri.slice("mk-file://".length) }));
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) { return <section className="tool-section"><span>{label}</span>{children}</section>; }
function ToolContent({ item }: { item: ToolCallContent }) {
  if (item.type === "content") return <ContentRenderer content={[item.content]} />;
  if (item.type === "diff") return <section className="tool-section"><span>文件变更 · {item.path}</span><pre className="diff-view">{item.newText}</pre></section>;
  return <p className="terminal-reference">终端：{item.terminalId}</p>;
}
function JsonValue({ value }: { value: unknown }) { let text: string; try { text = JSON.stringify(value, null, 2); } catch { text = String(value); } return <pre>{text}</pre>; }
function toolPhase(status: ToolCallEntry["status"]): ActivityPhase { if (status === "pending" || status === "in_progress") return "active"; if (status === "completed") return "completed"; return "failed"; }
function phaseLabel(phase: ActivityPhase) { if (phase === "active") return "执行中"; if (phase === "completed") return "完成"; if (phase === "failed") return "失败"; return ""; }
function toolIcon(entry: ToolCallEntry, phase: ActivityPhase) {
  if (phase === "active") return <LoaderCircle className="spin" size={15} />;
  if (phase === "failed") return <CircleAlert size={15} />;
  if (entry.name === "ask_user") return <MessageCircleQuestion size={15} />;
  if (entry.kind === "read" || entry.kind === "search" || entry.kind === "fetch") return <FileSearch size={15} />;
  if (entry.kind === "edit" || entry.kind === "move" || entry.kind === "delete") return <FilePenLine size={15} />;
  return phase === "completed" ? <Check size={15} /> : <Wrench size={15} />;
}
