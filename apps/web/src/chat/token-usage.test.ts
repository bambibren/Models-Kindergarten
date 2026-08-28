import { describe, expect, it } from "vitest";
import { emptyEntries, type EntryCollection, type TokenUsageEntry } from "./chat-types.js";
import { selectSessionTokenUsage } from "./token-usage.js";

describe("selectSessionTokenUsage", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("汇总输入输出，但不重复加入缓存和推理子集", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
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

  it("没有 usage 事实时不显示汇总", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    expect(selectSessionTokenUsage(emptyEntries())).toBeNull();
  });
});

/** 构造「usage」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
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

/** 构造「collection」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function collection(entry: TokenUsageEntry): EntryCollection {
  return { order: [entry.id], byId: { [entry.id]: entry } };
}
