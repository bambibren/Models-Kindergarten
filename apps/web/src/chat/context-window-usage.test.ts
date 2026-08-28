import { describe, expect, it } from "vitest";
import { emptyEntries, type ContextWindowUsageEntry, type EntryCollection } from "./chat-types.js";
import { formatContextPercent, projectContextWindowUsage, selectContextWindowUsage } from "./context-window-usage.js";

describe("selectContextWindowUsage", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("以最新 Turn 的下一次请求基线覆盖历史快照", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const history = collection(available("turn-1", 49_999, 100_000));
    const streaming = collection(available("turn-2", 50_000, 100_000));
    expect(selectContextWindowUsage(history, streaming)).toEqual({
      afterTurnId: "turn-2",
      estimatedTokens: 50_000,
      windowTokens: 100_000,
      remainingTokens: 50_000,
      percent: 50,
      ringPercent: 50,
      level: "warning",
    });
  });

  it("最新状态不可用时隐藏，而不是沿用旧 Session 快照", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const history = collection(available("turn-1", 10, 100));
    const unavailable: ContextWindowUsageEntry = {
      type: "context_window_usage",
      id: "context-window:turn-2",
      turnId: "turn-2",
      state: { schemaVersion: 1, status: "unavailable", afterTurnId: "turn-2", reason: "preview_failed" },
    };
    expect(selectContextWindowUsage(history, collection(unavailable))).toBeNull();
    expect(selectContextWindowUsage(emptyEntries())).toBeNull();
  });

  it("超过窗口时保留真实百分比，只把圆环限制为 100%", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    expect(projectContextWindowUsage(available("turn-3", 125_000, 100_000).state)).toMatchObject({
      percent: 125,
      ringPercent: 100,
      remainingTokens: 0,
      level: "critical",
    });
    expect(formatContextPercent(0.04)).toBe("<0.1%");
    expect(formatContextPercent(15)).toBe("15.0%");
    expect(formatContextPercent(125)).toBe(">100%");
  });
});

/** 构造「available」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function available(turnId: string, estimatedTokens: number, windowTokens: number): ContextWindowUsageEntry {
  return {
    type: "context_window_usage",
    id: `context-window:${turnId}`,
    turnId,
    state: {
      schemaVersion: 1,
      status: "available",
      afterTurnId: turnId,
      estimatedTokens,
      windowTokens,
      basis: "next_prompt_base",
    },
  };
}

/** 构造「collection」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function collection(entry: ContextWindowUsageEntry): EntryCollection {
  return { order: [entry.id], byId: { [entry.id]: entry } };
}
