import { describe, expect, it } from "vitest";
import { parseTurnEffectScoreDraft } from "./index.js";

describe("TurnEffectScoreDraft", () => {
  it("接受有界的单 Turn 人工标注", () => {
    expect(parseTurnEffectScoreDraft({
      schemaVersion: 1,
      annotations: {
        understanding: { requirements: [{ requirementId: "prompt-1", label: "复用真实消息组件", weight: 100, verdict: "met" }], completed: true },
        planning: { score: 73, completed: true },
        output: { score: 64, marks: [], completed: true },
      },
    })).toMatchObject({ annotations: { planning: { score: 73 }, output: { score: 64 } } });
  });

  it("拒绝越界评分和未知字段", () => {
    expect(() => parseTurnEffectScoreDraft({
      schemaVersion: 1,
      annotations: {
        understanding: { requirements: [], completed: false },
        planning: { score: 101, completed: true },
        output: { score: 0, marks: [], completed: false },
      },
    })).toThrow("0 到 100");
    expect(() => parseTurnEffectScoreDraft({ schemaVersion: 1, annotations: {}, extra: true })).toThrow();
  });
});
