import { describe, expect, it } from "vitest";
import { readContextLabEntryDraft, saveContextLabEntryDraft } from "./context-lab-entry-draft.js";

describe("context lab home entry draft", () => {
  it("原样交接 Prompt 和有序 Artifact ID，且不把内容暴露到 URL", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    const promptText = "  比较这两个方案\n保留换行  ";
    const url = saveContextLabEntryDraft(storage, promptText, [
      { artifactId: "artifact_first" },
      { artifactId: "artifact_second" },
    ], "entry-1");

    expect(url).toBe("/context-lab?entry=entry-1");
    expect(url).not.toContain("比较这两个方案");
    expect(url).not.toContain("artifact_first");
    expect(readContextLabEntryDraft(storage, "?entry=entry-1")).toEqual({
      schemaVersion: 1,
      promptText,
      artifactMentions: [{ artifactId: "artifact_first" }, { artifactId: "artifact_second" }],
    });
  });

  it("忽略损坏的浏览器会话草稿", () => {
    const storage = {
      getItem: () => JSON.stringify({ schemaVersion: 1, promptText: "任务", artifactMentions: [{ name: "伪造字段" }] }),
      setItem: () => undefined,
    };
    expect(readContextLabEntryDraft(storage, "?entry=broken")).toBeUndefined();
  });
});
