import { ArrowUp, Square } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { ModelReasoningCapability, ReasoningProfile } from "@kindergarten/contracts";
import type { ReasoningConfigView } from "../../reasoning/reasoning-config.js";
import { ReasoningProfileSelect } from "../reasoning/ReasoningProfileSelect.js";

export function Composer({ disabled, onCancel, onReasoningChange, onSend, reasoning, reasoningBusy = false, reasoningCapability, running }: {
  disabled: boolean;
  running: boolean;
  reasoning?: ReasoningConfigView;
  reasoningBusy?: boolean;
  reasoningCapability?: ModelReasoningCapability;
  onReasoningChange?: (profile: ReasoningProfile) => void;
  onSend: (text: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const element = ref.current; if (!element) return; element.style.height = "0px"; element.style.height = `${Math.min(element.scrollHeight, 180)}px`; }, [text]);
  async function submit(event?: FormEvent) { event?.preventDefault(); const value = text.trim(); if (!value || disabled || running) return; setText(""); await onSend(value); }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }
  return <form className="composer" onSubmit={(event) => void submit(event)}>
    <textarea ref={ref} value={text} rows={1} aria-label="消息输入" placeholder="给 ModelStudent 发送消息…" disabled={disabled} onChange={(event) => setText(event.target.value)} onKeyDown={keyDown} />
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
