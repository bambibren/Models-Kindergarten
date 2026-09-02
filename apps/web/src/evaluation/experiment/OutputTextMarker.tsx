import type { OutputAnnotationFacts } from "@kindergarten/contracts";
import { MarkerText } from "../demo/agent-evaluation/MarkerText.js";
import type { AnswerSectionTone, TextMark } from "../demo/agent-evaluation/types.js";

type OutputMark = OutputAnnotationFacts["marks"][number];

export interface OutputTextSection {
  answerSectionId: string;
  label: string;
  start: number;
  end: number;
  text: string;
}

/** 正式页只做契约转换，选区、浮层、改色和删除全部直接复用 Demo 的 MarkerText。 */
export function OutputTextMarker({ variantId, sections, marks, onChange }: {
  variantId: string;
  sections: OutputTextSection[];
  marks: OutputMark[];
  onChange: (marks: OutputMark[]) => void;
}) {
  const demoMarks = marks.filter((mark) => mark.verdict !== "none").map((mark) => toTextMark(mark, sections));
  return <MarkerText
    agentId={variantId}
    marks={demoMarks}
    onChange={(next) => void convertMarks(next, variantId, sections).then(onChange)}
    sections={sections.map((section, index) => ({
      id: section.answerSectionId,
      label: section.label,
      summary: section.label,
      text: section.text,
      tone: sectionTone(index, section.label),
    }))}
  />;
}

/** 兼容既有单测：把绝对字符区间投影为文本片段。 */
export function buildOutputSegments(section: OutputTextSection, marks: OutputMark[]): Array<{ key: string; text: string; mark?: OutputMark }> {
  const result: Array<{ key: string; text: string; mark?: OutputMark }> = [];
  let cursor = 0;
  for (const mark of marks.toSorted((left, right) => left.start - right.start)) {
    const start = clamp(mark.start - section.start, cursor, section.text.length);
    const end = clamp(mark.end - section.start, start, section.text.length);
    if (start > cursor) result.push({ key: `plain-${cursor}`, text: section.text.slice(cursor, start) });
    if (end > start) result.push({ key: markKey(mark), text: section.text.slice(start, end), mark });
    cursor = end;
  }
  if (cursor < section.text.length) result.push({ key: `plain-${cursor}`, text: section.text.slice(cursor) });
  return result;
}

function toTextMark(mark: OutputMark, sections: OutputTextSection[]): TextMark {
  const section = sections.find((item) => item.answerSectionId === mark.answerSectionId);
  return {
    id: markKey(mark),
    agentId: mark.variantId,
    sectionId: mark.answerSectionId,
    start: mark.start - (section?.start ?? 0),
    end: mark.end - (section?.start ?? 0),
    color: mark.verdict === "effective" ? "red" : "blue",
  };
}

async function convertMarks(marks: TextMark[], variantId: string, sections: OutputTextSection[]): Promise<OutputMark[]> {
  return Promise.all(marks.map(async (mark) => {
    const section = sections.find((item) => item.answerSectionId === mark.sectionId);
    if (!section) throw new Error(`输出分段不存在：${mark.sectionId}`);
    const start = section.start + mark.start;
    const end = section.start + mark.end;
    return {
      markId: mark.id,
      variantId,
      answerSectionId: mark.sectionId,
      start,
      end,
      verdict: mark.color === "red" ? "effective" as const : "partial" as const,
      quotedTextHash: await sha256(section.text.slice(mark.start, mark.end)),
    };
  }));
}

function sectionTone(index: number, label: string): AnswerSectionTone {
  if (/风险|回退|限制/u.test(label)) return "risk";
  if (/验证|检查|测试/u.test(label)) return "validation";
  if (/方案|步骤|实施|执行/u.test(label)) return "action";
  return (["analysis", "action", "validation", "risk"] as const)[index % 4]!;
}

function markKey(mark: OutputMark): string {
  return mark.markId ?? `${mark.variantId}:${mark.answerSectionId}:${mark.start}:${mark.end}`;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
