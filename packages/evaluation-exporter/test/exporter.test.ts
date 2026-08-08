import { describe, expect, it } from "vitest";
import type { TurnTraceDocument } from "@kindergarten/evaluation-contract";
import { EvaluationTraceExporter } from "../src/index.js";

describe("EvaluationTraceExporter", () => {
  it("按 runId 聚合乱序完成的工具并只上传一个终态文档", async () => {
    const documents: TurnTraceDocument[] = [];
    const exporter = new EvaluationTraceExporter("http://evaluation.test", async (_input, init) => {
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

    exporter.emit({
      type: "turn_started",
      runId: "run-1",
      sessionId: "session-1",
      turnId: "turn-1",
      startedAt: 10,
      variant,
    });
    exporter.emit({
      type: "model_round_started",
      runId: "run-1",
      roundId: "round-1",
      index: 0,
      startedAt: 11,
      context: { messages: [], truncatedSourceIds: [] },
    });
    exporter.emit({
      type: "tool_call_started",
      runId: "run-1",
      roundId: "round-1",
      toolCallId: "tool-1",
      name: "read_file",
      arguments: { path: "a.txt" },
      signature: "read_file:a.txt",
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
      toolCalls: [{ toolCallId: "tool-1", status: "success" }],
    });
  });
});
