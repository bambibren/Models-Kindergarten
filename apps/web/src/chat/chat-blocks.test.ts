import { describe, expect, it } from "vitest";
import {
  selectEntryBlocks,
} from "./chat-blocks.js";
import type {
  ContextSummaryEntry,
  EntryCollection,
  MessageEntry,
  ThoughtEntry,
  TokenUsageEntry,
  ToolCallEntry,
} from "./chat-types.js";

describe("selectEntryBlocks", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("只组合同一 Turn 中连续的 Thought 与 Tool", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const user = message("message:user", "turn-1", "user");
    const context = summary("context:turn-1", "turn-1");
    const thought = thinking("thought:one", "turn-1");
    const toolA = tool("tool:a", "turn-1", "a");
    const toolB = tool("tool:b", "turn-1", "b");
    const assistant = message("message:assistant", "turn-1", "assistant");
    const usage = tokenUsage("usage:turn-1", "turn-1");
    const nextThought = thinking("thought:two", "turn-2");
    const collection: EntryCollection = {
      order: [user.id, context.id, thought.id, toolA.id, toolB.id, assistant.id, usage.id, nextThought.id],
      byId: Object.fromEntries([user, context, thought, toolA, toolB, assistant, usage, nextThought].map(/** 构造「byId」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(entry) => [entry.id, entry])),
    };

    expect(selectEntryBlocks(collection)).toMatchObject([
      { type: "entry", entryId: user.id },
      { type: "entry", entryId: context.id },
      { type: "activity", turnId: "turn-1", itemIds: [thought.id, toolA.id, toolB.id] },
      { type: "entry", entryId: assistant.id },
      { type: "activity", turnId: "turn-2", itemIds: [nextThought.id] },
    ]);
  });
});

/** 构造「message」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function message(id: string, turnId: string, role: MessageEntry["role"]): MessageEntry {
  return { type: "message", id, messageId: id, turnId, role, content: [{ type: "text", text: id }], status: "done" };
}
/** 构造「thinking」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function thinking(id: string, turnId: string): ThoughtEntry {
  return { type: "thought", id, messageId: id, turnId, content: [{ type: "text", text: id }], status: "done" };
}
/** 构造「summary」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function summary(id: string, turnId: string): ContextSummaryEntry {
  return {
    type: "context_summary",
    id,
    turnId,
    summary: {
      schemaVersion: 1,
      turnId,
      items: [],
      totalEstimatedTokens: 0,
    },
  };
}
/** 构造「tokenUsage」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function tokenUsage(id: string, turnId: string): TokenUsageEntry {
  return {
    type: "token_usage",
    id,
    turnId,
    usage: {
      schemaVersion: 1,
      turnId,
      modelRequests: 1,
      inputTokens: 10,
      outputTokens: 5,
      components: [],
    },
  };
}
/** 构造「tool」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function tool(id: string, turnId: string, toolCallId: string): ToolCallEntry {
  return { type: "tool_call", id, toolCallId, turnId, title: id, kind: "other", status: "in_progress", content: [], locations: [] };
}
