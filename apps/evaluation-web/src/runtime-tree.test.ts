import { describe, expect, it } from "vitest";
import { buildRuntimeTree } from "./runtime-tree.js";

describe("Runtime Tree", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("保持 Round 和 Tool 开始顺序，不按完成顺序重排", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const trace = {
      modelRounds: [round("r2", 1), round("r1", 0)],
      toolCalls: [
        tool("b", "r1", 20, 30),
        tool("a", "r1", 10, 40),
      ],
    };
    const tree = buildRuntimeTree(trace);
    expect(tree.map(/** 构造「toEqual」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(item) => item.round.id)).toEqual(["r1", "r2"]);
    expect(tree[0]?.tools.map(/** 构造「toEqual」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(item) => item.toolCallId)).toEqual(["a", "b"]);
  });
});

/** 构造「round」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
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

/** 构造「tool」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function tool(toolCallId: string, modelRoundId: string, startedAt: number, completedAt: number) {
  return {
    toolCallId,
    modelRoundId,
    name: "read_file",
    arguments: { sha256: toolCallId, bytes: 2 },
    signatureHash: toolCallId,
    permission: "allow" as const,
    startedAt,
    completedAt,
  };
}
