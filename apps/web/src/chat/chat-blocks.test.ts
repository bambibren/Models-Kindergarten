import { describe, expect, it } from "vitest";
import {
  selectEntryBlocks,
  selectTurnEvaluationAnchors,
} from "./chat-blocks.js";
import type { EntryCollection, MessageEntry, ThoughtEntry, ToolCallEntry } from "./chat-types.js";

describe("selectEntryBlocks", () => {
  it("只组合同一 Turn 中连续的 Thought 与 Tool", () => {
    const user = message("message:user", "turn-1", "user");
    const thought = thinking("thought:one", "turn-1");
    const toolA = tool("tool:a", "turn-1", "a");
    const toolB = tool("tool:b", "turn-1", "b");
    const assistant = message("message:assistant", "turn-1", "assistant");
    const nextThought = thinking("thought:two", "turn-2");
    const collection: EntryCollection = {
      order: [user.id, thought.id, toolA.id, toolB.id, assistant.id, nextThought.id],
      byId: Object.fromEntries([user, thought, toolA, toolB, assistant, nextThought].map((entry) => [entry.id, entry])),
    };

    expect(selectEntryBlocks(collection)).toMatchObject([
      { type: "entry", entryId: user.id },
      { type: "activity", turnId: "turn-1", itemIds: [thought.id, toolA.id, toolB.id] },
      { type: "entry", entryId: assistant.id },
      { type: "activity", turnId: "turn-2", itemIds: [nextThought.id] },
    ]);
  });

  it("为每个真实 Turn 选择最后一个渲染块作为稳定评测入口", () => {
    const collection = entries([
      message("u1", "turn-1", "user"),
      thinking("t1", "turn-1"),
      message("a1", "turn-1", "assistant"),
      message("u2", "turn-2", "user"),
      tool("tool-2", "turn-2", "call-2"),
      message("a2", "turn-2", "assistant"),
      message("loading", "load:temporary", "assistant"),
    ]);
    expect(selectTurnEvaluationAnchors(collection)).toEqual([
      { turnId: "turn-1", afterBlockId: "entry:a1" },
      { turnId: "turn-2", afterBlockId: "entry:a2" },
    ]);
  });
});

function message(id: string, turnId: string, role: MessageEntry["role"]): MessageEntry {
  return { type: "message", id, messageId: id, turnId, role, content: [{ type: "text", text: id }], status: "done" };
}
function thinking(id: string, turnId: string): ThoughtEntry {
  return { type: "thought", id, messageId: id, turnId, content: [{ type: "text", text: id }], status: "done" };
}
function tool(id: string, turnId: string, toolCallId: string): ToolCallEntry {
  return { type: "tool_call", id, toolCallId, turnId, title: id, kind: "other", status: "in_progress", content: [], locations: [] };
}
function entries(values: Array<MessageEntry | ThoughtEntry | ToolCallEntry>): EntryCollection {
  return {
    order: values.map((entry) => entry.id),
    byId: Object.fromEntries(values.map((entry) => [entry.id, entry])),
  };
}
