import { describe, expect, it } from "vitest";
import { emptyEntries, type EntryCollection, type TokenUsageEntry } from "./chat-types.js";
import { selectSessionTokenUsage } from "./token-usage.js";

describe("selectSessionTokenUsage", () => {
  it("汇总输入输出，但不重复加入缓存和推理子集", () => {
    const history = collection(usage("turn-1", 120, 35, 80, 12));
    const streaming = collection(usage("turn-2", 70, 20, 40, 8));

    expect(selectSessionTokenUsage(history, streaming)).toEqual({
      turns: 2,
      modelRequests: 3,
      inputTokens: 190,
      outputTokens: 55,
      cachedInputTokens: 120,
      reasoningOutputTokens: 20,
    });
  });

  it("没有 usage 事实时不显示汇总", () => {
    expect(selectSessionTokenUsage(emptyEntries())).toBeNull();
  });
});

function usage(
  turnId: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
  reasoningOutputTokens: number,
): TokenUsageEntry {
  return {
    type: "token_usage",
    id: `usage:${turnId}`,
    turnId,
    usage: {
      schemaVersion: 1,
      turnId,
      modelRequests: turnId === "turn-1" ? 1 : 2,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      reasoningOutputTokens,
      components: [],
    },
  };
}

function collection(entry: TokenUsageEntry): EntryCollection {
  return { order: [entry.id], byId: { [entry.id]: entry } };
}
