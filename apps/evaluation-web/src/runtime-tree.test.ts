import { describe, expect, it } from "vitest";
import { buildRuntimeTree } from "./runtime-tree.js";

describe("Runtime Tree", () => {
  it("保持 Round 和 Tool 开始顺序，不按完成顺序重排", () => {
    const trace = {
      modelRounds: [round("r2", 1), round("r1", 0)],
      toolCalls: [
        tool("b", "r1", 20, 30),
        tool("a", "r1", 10, 40),
      ],
    };
    const tree = buildRuntimeTree(trace);
    expect(tree.map((item) => item.round.id)).toEqual(["r1", "r2"]);
    expect(tree[0]?.tools.map((item) => item.toolCallId)).toEqual(["a", "b"]);
  });
});

function round(id: string, index: number) {
  return {
    id,
    index,
    startedAt: 0,
    resolvedReasoning: {
      schemaVersion: 1 as const,
      requestedProfile: "auto" as const,
      resolvedProfile: "balanced" as const,
      source: "model_default" as const,
      providerKind: "ollama",
      model: "fixture",
      native: {},
    },
    context: { messages: [], truncatedSourceIds: [] },
  };
}

function tool(toolCallId: string, modelRoundId: string, startedAt: number, completedAt: number) {
  return {
    toolCallId,
    modelRoundId,
    name: "read_file",
    arguments: {},
    signature: toolCallId,
    permission: "allow" as const,
    startedAt,
    completedAt,
  };
}
