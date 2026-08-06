import { describe, expect, it } from "vitest";
import { selectEntryBlocks } from "./chat-blocks.js";
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
