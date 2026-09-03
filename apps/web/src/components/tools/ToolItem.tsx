import * as Collapsible from "@radix-ui/react-collapsible";
import { Check, ChevronDown, CircleAlert, FilePenLine, FileSearch, LoaderCircle, MessageCircleQuestion, Wrench } from "lucide-react";
import type { ToolCallContent } from "@agentclientprotocol/sdk";
import type { ToolCallEntry } from "../../chat/chat-types.js";
import { useAutoDisclosure, type ActivityPhase } from "../../hooks/use-auto-disclosure.js";
import { ContentRenderer } from "../chat/ContentRenderer.js";
import { formatTokenCount } from "../tokens/token-format.js";

/** 渲染「ToolItem」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function ToolItem({ entry }: { entry: ToolCallEntry }) {
  const phase = toolPhase(entry.status);
  const disclosure = useAutoDisclosure(phase);
  const artifacts = entry.content.flatMap(/** 执行「artifacts」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(item) =>
    item.type === "content" && item.content.type === "resource_link" && item.content.uri.startsWith("artifact://")
      ? [item.content]
      : []);
  return <Collapsible.Root className={`activity-item tool-item phase-${phase}`} open={disclosure.open} onOpenChange={disclosure.setOpen}>
    <Collapsible.Trigger className="activity-trigger">
      <span className="activity-icon">{toolIcon(entry, phase)}</span>
      <span className="activity-title">{entry.title}</span>
      <span className="activity-meta">
        <span className="activity-status">{phaseLabel(entry.status)}</span>
        {entry.tokenEstimate && <span className="activity-token">调用约 {formatTokenCount(entry.tokenEstimate.estimatedTokens)} tokens</span>}
      </span>
      <ChevronDown className="disclosure-chevron" size={15} />
    </Collapsible.Trigger>
    {artifacts.length > 0 && <div className="tool-artifact-actions">
      {artifacts.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(artifact) => <button key={artifact.uri} type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => openArtifact(artifact.uri)}>预览 {artifact.title ?? artifact.name}</button>)}
    </div>}
    <Collapsible.Content className="activity-content tool-detail">
      {entry.rawInput !== undefined && <Detail label="输入"><JsonValue value={entry.rawInput} /></Detail>}
      {entry.content.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item, index) => <ToolContent item={item} key={`${entry.toolCallId}:${index}`} />)}
      {entry.rawOutput !== undefined && <Detail label="输出"><JsonValue value={entry.rawOutput} /></Detail>}
    </Collapsible.Content>
  </Collapsible.Root>;
}

/** 执行「openArtifact」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function openArtifact(uri: string): void {
  window.dispatchEvent(new CustomEvent("mk-open-artifact", { detail: uri.slice("artifact://".length) }));
}

/** 渲染「Detail」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function Detail({ label, children }: { label: string; children: React.ReactNode }) { return <section className="tool-section"><span>{label}</span>{children}</section>; }
/** 渲染「ToolContent」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function ToolContent({ item }: { item: ToolCallContent }) {
  if (item.type === "content") return <ContentRenderer content={[item.content]} />;
  if (item.type === "diff") return <section className="tool-section"><span>文件变更 · {item.path}</span><pre className="diff-view">{item.newText}</pre></section>;
  return <p className="terminal-reference">终端：{item.terminalId}</p>;
}
/** 渲染「JsonValue」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function JsonValue({ value }: { value: unknown }) { let text: string; try { text = JSON.stringify(value, null, 2); } catch { text = String(value); } return <pre>{text}</pre>; }
/** 根据已校验输入构建「toolPhase」结果，不额外持有调用方的大对象。 */
function toolPhase(status: ToolCallEntry["status"]): ActivityPhase { if (status === "pending" || status === "in_progress") return "active"; if (status === "completed") return "completed"; return "failed"; }
/** 执行「phaseLabel」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function phaseLabel(status: ToolCallEntry["status"]) { if (status === "pending") return "准备中"; if (status === "in_progress") return "执行中"; if (status === "completed") return "完成"; return "失败"; }
/** 根据已校验输入构建「toolIcon」结果，不额外持有调用方的大对象。 */
function toolIcon(entry: ToolCallEntry, phase: ActivityPhase) {
  if (phase === "active") return <LoaderCircle className="spin" size={15} />;
  if (phase === "failed") return <CircleAlert size={15} />;
  if (entry.name === "ask_user") return <MessageCircleQuestion size={15} />;
  if (entry.kind === "read" || entry.kind === "search" || entry.kind === "fetch") return <FileSearch size={15} />;
  if (entry.kind === "edit" || entry.kind === "move" || entry.kind === "delete") return <FilePenLine size={15} />;
  return phase === "completed" ? <Check size={15} /> : <Wrench size={15} />;
}
