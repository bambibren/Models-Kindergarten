import { ArrowUp, FileArchive, FileCode2, FileText, Search, Square, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { ArtifactMentionInput, ArtifactRecord, ModelReasoningCapability, ReasoningProfile } from "@kindergarten/contracts";
import type { ReasoningConfigView } from "../../reasoning/reasoning-config.js";
import { ReasoningProfileSelect } from "../reasoning/ReasoningProfileSelect.js";
import { controlApi } from "../../api/control-api.js";
import { addMention, mentionInputs, mentionQuery, removeMentionTrigger } from "./composer-mention.js";
import type { ContextWindowUsageView } from "../../chat/context-window-usage.js";
import { ContextWindowUsageIndicator } from "./ContextWindowUsageIndicator.js";

/** 渲染「Composer」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function Composer({ contextWindowUsage, disabled, onCancel, onReasoningChange, onSend, reasoning, reasoningBusy = false, reasoningCapability, running }: {
  contextWindowUsage: ContextWindowUsageView | null;
  disabled: boolean;
  running: boolean;
  reasoning?: ReasoningConfigView;
  reasoningBusy?: boolean;
  reasoningCapability?: ModelReasoningCapability;
  onReasoningChange?: (profile: ReasoningProfile) => void;
  onSend: (text: string, artifactMentions: ArtifactMentionInput[]) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const [mentions, setMentions] = useState<ArtifactRecord[]>([]);
  const [options, setOptions] = useState<ArtifactRecord[]>([]);
  const [activeOption, setActiveOption] = useState(0);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(/** 同步组件生命周期内的外部状态，并在清理阶段释放订阅或临时资源。 */
() => { const element = ref.current; if (!element) return; element.style.height = "0px"; element.style.height = `${Math.min(element.scrollHeight, 180)}px`; }, [text]);
  const query = mentionQuery(text);
  useEffect(/** 同步组件生命周期内的外部状态，并在清理阶段释放订阅或临时资源。 */
() => {
    if (query === null || disabled || running) { setOptions([]); setSearching(false); setSearchError(null); return; }
    let disposed = false;
    const timer = window.setTimeout(/** 执行受生命周期约束的定时任务，调用方负责在结束时取消句柄。 */
() => {
      setSearching(true);
      setSearchError(null);
      void controlApi.artifacts(query, "active").then(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
(value) => {
        if (disposed) return;
        setOptions(value.items.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => !mentions.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(mention) => mention.artifactId === item.artifactId)).slice(0, 8));
        setActiveOption(0);
      }).catch(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
(error: unknown) => {
        if (!disposed) {
          console.error("搜索 Artifact 失败", error);
          setOptions([]);
          setSearchError(error instanceof Error ? error.message : "Artifact 列表读取失败");
        }
      }).finally(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => { if (!disposed) setSearching(false); });
    }, 120);
    return /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */ () => { disposed = true; window.clearTimeout(timer); };
  }, [disabled, mentions, query, running]);

  /** 执行「submit」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async function submit(event?: FormEvent) {
    event?.preventDefault();
    const value = text.trim();
    if (!value || disabled || running) return;
    const sent = await onSend(value, mentionInputs(mentions));
    if (sent) { setText(""); setMentions([]); setOptions([]); setSearchError(null); }
  }
  /** 执行「select」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function select(artifact: ArtifactRecord) {
    setMentions(/** 执行「select」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(current) => addMention(current, artifact));
    setText(/** 执行「select」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(current) => removeMentionTrigger(current));
    setOptions([]);
    setSearchError(null);
    requestAnimationFrame(/** 执行「select」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => ref.current?.focus());
  }
  /** 执行「keyDown」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (query !== null && options.length > 0) {
      if (event.key === "ArrowDown") { event.preventDefault(); setActiveOption(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(value) => (value + 1) % options.length); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); setActiveOption(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(value) => (value - 1 + options.length) % options.length); return; }
      if (event.key === "Escape") { event.preventDefault(); setOptions([]); return; }
      if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); const item = options[activeOption]; if (item) select(item); return; }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
  }
  return <form className="composer" onSubmit={/** 处理「onSubmit」事件，校验归属后再推进状态且避免重复提交。 */
(event) => void submit(event)}>
    {mentions.length > 0 && <div className="composer-mention-tags" aria-label="已引用产物">{mentions.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(artifact) => <span className="composer-mention-tag" key={artifact.artifactId} title={`${artifact.displayName} · ${artifact.artifactId}`}>
      {artifact.kind === "html_bundle" ? <FileCode2 size={12} /> : artifact.primary.mimeType.startsWith("image/") ? <FileArchive size={12} /> : <FileText size={12} />}
      <strong>{artifact.displayName}</strong><small>{artifact.artifactId.slice(-6)}</small>
      <button aria-label={`移除 ${artifact.displayName}`} type="button" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => setMentions(/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
(current) => current.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.artifactId !== artifact.artifactId))}><X size={11} /></button>
    </span>)}</div>}
    <div className="composer-input-wrap">
    <textarea ref={ref} value={text} rows={1} aria-label="消息输入" placeholder="给 ModelStudent 发送消息…" disabled={disabled} onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(event) => setText(event.target.value)} onKeyDown={keyDown} />
    {query !== null && <div className="composer-mention-menu" role="listbox" aria-label="选择已有产物">
      <header><Search size={12} /><span>{searching ? "正在搜索" : "引用我的产物"}</span></header>
      {searchError ? <p role="alert">读取失败：{searchError}</p> : !searching && options.length === 0 ? <p>没有可引用的 Artifact</p> : options.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(artifact, index) => <button
        aria-selected={index === activeOption}
        className={index === activeOption ? "active" : ""}
        key={artifact.artifactId}
        role="option"
        type="button"
        onMouseDown={/** 处理「onMouseDown」事件，校验归属后再推进状态且避免重复提交。 */
(event) => event.preventDefault()}
        onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => select(artifact)}
      ><span><strong>{artifact.displayName}</strong><small>{artifact.kind === "html_bundle" ? "HTML Bundle" : artifact.primary.mimeType} · {artifact.artifactId.slice(-8)}</small></span></button>)}
    </div>}
    </div>
    <div className="composer-meta"><div className="composer-settings">
      {reasoning && onReasoningChange && <ReasoningProfileSelect
        busy={reasoningBusy}
        {...(reasoningCapability ? { capability: reasoningCapability } : {})}
        choices={reasoning.choices}
        disabled={disabled || running}
        onChange={onReasoningChange}
        value={reasoning.currentProfile}
      />}
      <span>本地模型可能会出错，请核对重要信息</span>
    </div><div className="composer-actions">
      {contextWindowUsage && <ContextWindowUsageIndicator value={contextWindowUsage} />}
      {running ? <button className="composer-action stop" type="button" aria-label="停止生成" onClick={onCancel}><Square size={13} fill="currentColor" /></button> : <button className="composer-action" type="submit" aria-label="发送" disabled={disabled || !text.trim()}><ArrowUp size={18} strokeWidth={2.4} /></button>}
    </div></div>
  </form>;
}
