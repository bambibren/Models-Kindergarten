import { describe, expect, it } from "vitest";
import type { TurnTraceDocument } from "@kindergarten/evaluation-contract";
import { EvaluationTraceExporter } from "../src/index.js";

describe("EvaluationTraceExporter", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("按 runId 聚合乱序完成的工具并只上传一个终态文档", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const documents: TurnTraceDocument[] = [];
    const exporter = new EvaluationTraceExporter("http://evaluation.test", /** 构造「exporter」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async (_input, init) => {
      documents.push(JSON.parse(String(init?.body)) as TurnTraceDocument);
      return new Response(null, { status: 201 });
    });
    const variant = {
      studentId: "student",
      studentName: "Student",
      provider: "ollama",
      model: "qwen3:8b",
      systemPromptHash: "hash",
      runtimeVersion: "1.5",
      toolNames: ["read_file"],
    };
    const resolvedReasoning = {
      schemaVersion: 1 as const,
      requestedProfile: "max" as const,
      resolvedProfile: "max" as const,
      source: "session_override" as const,
      providerKind: "ollama",
      model: "qwen3:8b",
      native: { think: true },
    };

    exporter.emit({
      type: "turn_started",
      runId: "run-1",
      sessionId: "session-1",
      turnId: "turn-1",
      startedAt: 10,
      variant,
      resolvedReasoning,
    });
    exporter.emit({
      type: "model_round_started",
      runId: "run-1",
      roundId: "round-1",
      index: 0,
      startedAt: 11,
      resolvedReasoning,
      context: { messages: [], truncatedSourceIds: [] },
    });
    exporter.emit({
      type: "model_round_usage",
      runId: "run-1",
      roundId: "round-1",
      inputTokens: 100,
      outputTokens: 30,
      cachedInputTokens: 40,
      reasoningOutputTokens: 12,
    });
    exporter.emit({
      type: "tool_call_started",
      runId: "run-1",
      roundId: "round-1",
      toolCallId: "tool-1",
      name: "read_file",
      arguments: { sha256: "arguments-hash", bytes: 16 },
      signatureHash: "signature-hash",
      permission: "allow",
      startedAt: 12,
    });
    exporter.emit({
      type: "tool_call_completed",
      runId: "run-1",
      toolCallId: "tool-1",
      status: "success",
      completedAt: 13,
    });
    exporter.emit({
      type: "turn_completed",
      runId: "run-1",
      status: "completed",
      stopReason: "stop",
      completedAt: 20,
    });
    await exporter.flush();

    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      sessionId: "session-1",
      turnId: "turn-1",
      resolvedReasoning: { resolvedProfile: "max", native: { think: true } },
      modelRounds: [{
        resolvedReasoning: { resolvedProfile: "max" },
        context: { inputTokens: 100 },
        outputTokens: 30,
        cachedInputTokens: 40,
        reasoningOutputTokens: 12,
      }],
      toolCalls: [{ toolCallId: "tool-1", status: "success" }],
    });
    expect(exporter.takeTrace("session-1", "turn-1")).toMatchObject({ turnId: "turn-1" });
    expect(exporter.takeTrace("session-1", "turn-1")).toBeUndefined();
  });

  it("连续一百个 Turn 后仍只保留最近八条尚未消费的终态 Trace", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const exporter = new EvaluationTraceExporter("http://evaluation.test", /** 构造「exporter」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => new Response(null, { status: 201 }));
    const variant = {
      studentId: "student",
      studentName: "Student",
      provider: "ollama",
      model: "qwen3:8b",
      systemPromptHash: "hash",
      runtimeVersion: "1.5",
      toolNames: [],
    };
    const resolvedReasoning = {
      schemaVersion: 1 as const,
      requestedProfile: "balanced" as const,
      resolvedProfile: "balanced" as const,
      source: "model_default" as const,
      providerKind: "ollama",
      model: "qwen3:8b",
      native: { think: true },
    };
    for (let index = 0; index < 100; index += 1) {
      exporter.emit({
        type: "turn_started",
        runId: `run-${index}`,
        sessionId: "session",
        turnId: `turn-${index}`,
        startedAt: index,
        variant,
        resolvedReasoning,
      });
      exporter.emit({
        type: "turn_completed",
        runId: `run-${index}`,
        status: "completed",
        completedAt: index + 1,
      });
    }

    expect(exporter.takeTrace("session", "turn-91")).toBeUndefined();
    expect(exporter.takeTrace("session", "turn-92")).toMatchObject({ turnId: "turn-92" });
  });

  it("上传达到四个并发后不建立等待队列，完成后会释放名额", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    let releaseUploads: (() => void) | undefined;
    const release = new Promise<void>(/** 保存测试控制的上传完成信号。 */
(resolve) => { releaseUploads = resolve; });
    let uploads = 0;
    const exporter = new EvaluationTraceExporter("http://evaluation.test", /** 阻塞 HTTP 完成，以观察真实的在途 Promise 数。 */
async () => {
      uploads += 1;
      await release;
      return new Response(null, { status: 201 });
    });
    const variant = {
      studentId: "student",
      studentName: "Student",
      provider: "ollama",
      model: "qwen3:8b",
      systemPromptHash: "hash",
      runtimeVersion: "1.5",
      toolNames: [],
    };
    const resolvedReasoning = {
      schemaVersion: 1 as const,
      requestedProfile: "balanced" as const,
      resolvedProfile: "balanced" as const,
      source: "model_default" as const,
      providerKind: "ollama",
      model: "qwen3:8b",
      native: { think: true },
    };
    for (let index = 0; index < 5; index += 1) {
      exporter.emit({
        type: "turn_started",
        runId: `concurrent-${index}`,
        sessionId: "session",
        turnId: `turn-${index}`,
        startedAt: index,
        variant,
        resolvedReasoning,
      });
      exporter.emit({
        type: "turn_completed",
        runId: `concurrent-${index}`,
        status: "completed",
        completedAt: index + 1,
      });
    }

    expect(uploads).toBe(4);
    releaseUploads?.();
    await exporter.flush();

    exporter.emit({
      type: "turn_started",
      runId: "after-release",
      sessionId: "session",
      turnId: "after-release",
      startedAt: 10,
      variant,
      resolvedReasoning,
    });
    exporter.emit({
      type: "turn_completed",
      runId: "after-release",
      status: "completed",
      completedAt: 11,
    });
    await exporter.flush();
    expect(uploads).toBe(5);
  });
});
