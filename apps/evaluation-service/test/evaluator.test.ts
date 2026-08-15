import { describe, expect, it } from "vitest";
import type { TurnTraceDocument } from "@kindergarten/evaluation-contract";
import { evaluateTurn } from "../src/evaluator.js";

describe("Minimal Evaluator", () => {
  it("区分工具失败、重复请求、权限违规和客观 Token 指标", () => {
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
});

function fixture(): TurnTraceDocument {
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
