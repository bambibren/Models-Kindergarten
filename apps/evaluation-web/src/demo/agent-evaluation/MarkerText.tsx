import { Check, Highlighter, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import type { AgentId, DemoAnswerSection, MarkColor, TextMark } from "./types.js";

type ToolbarState =
  | { kind: "selection"; sectionId: string; start: number; end: number; x: number; y: number }
  | { kind: "mark"; markId: string; x: number; y: number };

export function MarkerText({
  agentId,
  sections,
  marks,
  onChange,
}: {
  agentId: AgentId;
  sections: DemoAnswerSection[];
  marks: TextMark[];
  onChange: (marks: TextMark[]) => void;
}) {
  const [toolbar, setToolbar] = useState<ToolbarState | null>(null);

  useEffect(() => {
    function close(event: PointerEvent) {
      const element = event.target instanceof Element ? event.target : null;
      if (element?.closest(".marker-toolbar") || element?.closest(".marked-text")) return;
      setToolbar(null);
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") setToolbar(null);
    }
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, []);

  function readSelection(event: ReactMouseEvent<HTMLDivElement>): void {
    const root = event.currentTarget;
    const sectionId = root.dataset.sectionId;
    const selection = window.getSelection();
    if (!sectionId || !selection || selection.rangeCount === 0 || selection.isCollapsed) return;
    if (!selection.anchorNode || !selection.focusNode) return;
    if (!root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return;

    const range = selection.getRangeAt(0);
    const content = range.toString();
    if (!content.trim()) return;
    const prefix = range.cloneRange();
    prefix.selectNodeContents(root);
    prefix.setEnd(range.startContainer, range.startOffset);
    const start = prefix.toString().length;
    const rect = range.getBoundingClientRect();
    setToolbar({
      kind: "selection",
      sectionId,
      start,
      end: start + content.length,
      x: clamp(rect.left + rect.width / 2, 74, window.innerWidth - 74),
      y: Math.max(54, rect.top - 8),
    });
  }

  function applyColor(color: MarkColor): void {
    if (!toolbar) return;
    if (toolbar.kind === "mark") {
      onChange(marks.map((mark) => mark.id === toolbar.markId ? { ...mark, color } : mark));
    } else {
      const next = marks.filter((mark) => mark.sectionId !== toolbar.sectionId || toolbar.end <= mark.start || toolbar.start >= mark.end);
      next.push({
        id: crypto.randomUUID(),
        agentId,
        sectionId: toolbar.sectionId,
        start: toolbar.start,
        end: toolbar.end,
        color,
      });
      onChange(next.toSorted((a, b) => a.start - b.start));
    }
    window.getSelection()?.removeAllRanges();
    setToolbar(null);
  }

  function removeMark(): void {
    if (toolbar?.kind !== "mark") return;
    onChange(marks.filter((mark) => mark.id !== toolbar.markId));
    setToolbar(null);
  }

  const toolbarStyle = toolbar
    ? ({ left: toolbar.x, top: toolbar.y } satisfies CSSProperties)
    : undefined;

  return <div className="marker-workspace">
    <div className="marker-help"><Highlighter size={13} />拖选文字后选择马克笔颜色</div>
    <div className="marker-text">
      {sections.map((section) => <section className={`output-block block-${section.tone}`} key={section.id}>
        <header><span>{section.label}</span><strong>{section.summary}</strong></header>
        <div className="output-block-text" data-section-id={section.id} onMouseUp={readSelection}>
          {buildSegments(section.text, marks.filter((mark) => mark.sectionId === section.id)).map((segment) => segment.mark
            ? <mark
              className={`marked-text mark-${segment.mark.color}`}
              key={segment.key}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setToolbar({
                  kind: "mark",
                  markId: segment.mark!.id,
                  x: clamp(rect.left + rect.width / 2, 74, window.innerWidth - 74),
                  y: Math.max(54, rect.top - 8),
                });
              }}
            >{segment.text}</mark>
            : <span key={segment.key}>{segment.text}</span>)}
        </div>
      </section>)}
    </div>
    {toolbar && <div className="marker-toolbar" role="toolbar" style={toolbarStyle}>
      <button aria-label="使用蓝色马克笔" className="marker-blue" onClick={() => applyColor("blue")} type="button"><Check size={12} /></button>
      <button aria-label="使用红色马克笔" className="marker-red" onClick={() => applyColor("red")} type="button"><Check size={12} /></button>
      {toolbar.kind === "mark" && <button aria-label="删除标注" className="marker-delete" onClick={removeMark} type="button"><Trash2 size={12} /></button>}
    </div>}
  </div>;
}

function buildSegments(text: string, marks: TextMark[]): Array<{
  key: string;
  text: string;
  mark?: TextMark;
}> {
  const result: Array<{ key: string; text: string; mark?: TextMark }> = [];
  let cursor = 0;
  for (const mark of marks.toSorted((a, b) => a.start - b.start)) {
    const start = clamp(mark.start, cursor, text.length);
    const end = clamp(mark.end, start, text.length);
    if (start > cursor) result.push({ key: `plain-${cursor}`, text: text.slice(cursor, start) });
    if (end > start) result.push({ key: mark.id, text: text.slice(start, end), mark });
    cursor = end;
  }
  if (cursor < text.length) result.push({ key: `plain-${cursor}`, text: text.slice(cursor) });
  return result;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
