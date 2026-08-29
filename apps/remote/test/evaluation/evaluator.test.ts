import { describe, expect, it } from "vitest";
import type { LegacyTurnTraceDocumentV1 } from "@kindergarten/evaluation-contract";
import { evaluateTurn } from "../../src/evaluation/evaluator.js";
import { normalizeTurnTrace } from "../../src/evaluation/trace-migration.js";

describe("Minimal Evaluator", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("区分工具失败、重复请求、权限违规和客观 Token 指标", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const trace = fixture();
    const result = evaluateTurn(trace);
    expect(result).toEqual({
      normallyCompleted: true,
      modelRoundCount: 2,
      toolCallCount: 3,
      toolSuccessCount: 1,
      toolFailureCount: 1,
      hasRepeatedToolCall: true,
      totalContextTokens: 300,
      truncatedContextItemCount: 1,
      firstTokenLatencyMs: 30,
      totalDurationMs: 400,
      totalOutputTokens: 50,
      errorCount: 2,
      permissionViolationCount: 1,
    });
  });

  it("V1 原文 Trace 转为 V2 摘要后保持最小评测结果等价", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const legacy = fixture();
    expect(evaluateTurn(normalizeTurnTrace(legacy))).toEqual(evaluateTurn(legacy));
  });
});

/** 构造「fixture」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function fixture(): LegacyTurnTraceDocumentV1 {
  const resolvedReasoning = {
    schemaVersion: 1 as const,
    requestedProfile: "deep" as const,
    resolvedProfile: "deep" as const,
    source: "model_default" as const,
    providerKind: "ollama",
    model: "qwen3:8b",
    native: { think: true },
  };
  return {
    schemaVersion: 1,
    traceId: "trace",
    runId: "run",
    sessionId: "session",
    turnId: "turn",
    resolvedReasoning,
    variant: {
      studentId: "student",
      studentName: "Student",
      provider: "ollama",
      model: "qwen3:8b",
      systemPromptHash: "hash",
      runtimeVersion: "1.5",
      toolNames: ["read_file", "write_file"],
    },
    status: "completed",
    stopReason: "stop",
    startedAt: 100,
    completedAt: 500,
    modelRounds: [
      {
        id: "round-1",
        index: 0,
        startedAt: 110,
        resolvedReasoning,
        firstTokenAt: 130,
        context: { messages: [], truncatedSourceIds: ["old"], inputTokens: 100 },
        outputTokens: 20,
      },
      {
        id: "round-2",
        index: 1,
        startedAt: 300,
        resolvedReasoning,
        context: { messages: [], truncatedSourceIds: ["old"], inputTokens: 200 },
        outputTokens: 30,
      },
    ],
    toolCalls: [
      {
        toolCallId: "one",
        modelRoundId: "round-1",
        name: "read_file",
        arguments: { path: "a" },
        signature: "read:a",
        permission: "allow",
        status: "success",
        startedAt: 150,
      },
      {
        toolCallId: "two",
        modelRoundId: "round-1",
        name: "read_file",
        arguments: { path: "a" },
        signature: "read:a",
        permission: "allow",
        status: "duplicate_blocked",
        startedAt: 160,
      },
      {
        toolCallId: "three",
        modelRoundId: "round-1",
        name: "write_file",
        arguments: { path: "b" },
        signature: "write:b",
        permission: "ask",
        status: "error",
        startedAt: 170,
      },
    ],
    permissions: [],
    errors: [{ scope: "turn", message: "notice", at: 400 }],
  };
}
