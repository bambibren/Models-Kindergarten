import { ArrowUp, FileArchive, FileCode2, FileText, Search, Square, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { ArtifactMentionInput, ArtifactRecord, ModelReasoningCapability, ReasoningProfile } from "@kindergarten/contracts";
import type { ReasoningConfigView } from "../../reasoning/reasoning-config.js";
import { ReasoningProfileSelect } from "../reasoning/ReasoningProfileSelect.js";
import { controlApi } from "../../api/control-api.js";
import { addMention, mentionInputs, mentionQuery, removeMentionTrigger } from "./composer-mention.js";

export function Composer({ disabled, onCancel, onReasoningChange, onSend, reasoning, reasoningBusy = false, reasoningCapability, running }: {
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
  useEffect(() => { const element = ref.current; if (!element) return; element.style.height = "0px"; element.style.height = `${Math.min(element.scrollHeight, 180)}px`; }, [text]);
  const query = mentionQuery(text);
  useEffect(() => {
    if (query === null || disabled || running) { setOptions([]); setSearching(false); setSearchError(null); return; }
    let disposed = false;
    const timer = window.setTimeout(() => {
      setSearching(true);
      setSearchError(null);
      void controlApi.artifacts(query, "active").then((value) => {
        if (disposed) return;
        setOptions(value.items.filter((item) => !mentions.some((mention) => mention.artifactId === item.artifactId)).slice(0, 8));
        setActiveOption(0);
      }).catch((error: unknown) => {
        if (!disposed) {
          console.error("搜索 Artifact 失败", error);
          setOptions([]);
          setSearchError(error instanceof Error ? error.message : "Artifact 列表读取失败");
        }
      }).finally(() => { if (!disposed) setSearching(false); });
    }, 120);
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [disabled, mentions, query, running]);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const value = text.trim();
    if (!value || disabled || running) return;
    const sent = await onSend(value, mentionInputs(mentions));
    if (sent) { setText(""); setMentions([]); setOptions([]); setSearchError(null); }
  }
  function select(artifact: ArtifactRecord) {
    setMentions((current) => addMention(current, artifact));
    setText((current) => removeMentionTrigger(current));
    setOptions([]);
    setSearchError(null);
    requestAnimationFrame(() => ref.current?.focus());
  }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (query !== null && options.length > 0) {
      if (event.key === "ArrowDown") { event.preventDefault(); setActiveOption((value) => (value + 1) % options.length); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); setActiveOption((value) => (value - 1 + options.length) % options.length); return; }
      if (event.key === "Escape") { event.preventDefault(); setOptions([]); return; }
      if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); const item = options[activeOption]; if (item) select(item); return; }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
  }
  return <form className="composer" onSubmit={(event) => void submit(event)}>
    {mentions.length > 0 && <div className="composer-mention-tags" aria-label="已引用产物">{mentions.map((artifact) => <span className="composer-mention-tag" key={artifact.artifactId} title={`${artifact.displayName} · ${artifact.artifactId}`}>
      {artifact.kind === "html_bundle" ? <FileCode2 size={12} /> : artifact.primary.mimeType.startsWith("image/") ? <FileArchive size={12} /> : <FileText size={12} />}
      <strong>{artifact.displayName}</strong><small>{artifact.artifactId.slice(-6)}</small>
      <button aria-label={`移除 ${artifact.displayName}`} type="button" onClick={() => setMentions((current) => current.filter((item) => item.artifactId !== artifact.artifactId))}><X size={11} /></button>
    </span>)}</div>}
    <div className="composer-input-wrap">
    <textarea ref={ref} value={text} rows={1} aria-label="消息输入" placeholder="给 ModelStudent 发送消息…" disabled={disabled} onChange={(event) => setText(event.target.value)} onKeyDown={keyDown} />
    {query !== null && <div className="composer-mention-menu" role="listbox" aria-label="选择已有产物">
      <header><Search size={12} /><span>{searching ? "正在搜索" : "引用我的产物"}</span></header>
      {searchError ? <p role="alert">读取失败：{searchError}</p> : !searching && options.length === 0 ? <p>没有可引用的 Artifact</p> : options.map((artifact, index) => <button
        aria-selected={index === activeOption}
        className={index === activeOption ? "active" : ""}
        key={artifact.artifactId}
        role="option"
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => select(artifact)}
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
    </div>{running ? <button className="composer-action stop" type="button" aria-label="停止生成" onClick={onCancel}><Square size={13} fill="currentColor" /></button> : <button className="composer-action" type="submit" aria-label="发送" disabled={disabled || !text.trim()}><ArrowUp size={18} strokeWidth={2.4} /></button>}</div>
  </form>;
}
