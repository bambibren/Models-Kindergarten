import { ArrowUp, Square } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

export function Composer({ disabled, running, onSend, onCancel }: { disabled: boolean; running: boolean; onSend: (text: string) => Promise<void>; onCancel: () => void }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const element = ref.current; if (!element) return; element.style.height = "0px"; element.style.height = `${Math.min(element.scrollHeight, 180)}px`; }, [text]);
  async function submit(event?: FormEvent) { event?.preventDefault(); const value = text.trim(); if (!value || disabled || running) return; setText(""); await onSend(value); }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }
  return <form className="composer" onSubmit={(event) => void submit(event)}>
    <textarea ref={ref} value={text} rows={1} aria-label="消息输入" placeholder="给 ModelStudent 发送消息…" disabled={disabled} onChange={(event) => setText(event.target.value)} onKeyDown={keyDown} />
    <div className="composer-meta"><span>本地模型可能会出错，请核对重要信息</span>{running ? <button className="composer-action stop" type="button" aria-label="停止生成" onClick={onCancel}><Square size={13} fill="currentColor" /></button> : <button className="composer-action" type="submit" aria-label="发送" disabled={disabled || !text.trim()}><ArrowUp size={18} strokeWidth={2.4} /></button>}</div>
  </form>;
}
