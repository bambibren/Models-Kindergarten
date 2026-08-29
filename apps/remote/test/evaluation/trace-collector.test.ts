import { describe, expect, it } from "vitest";
import type { TurnTraceDocument } from "@kindergarten/evaluation-contract";
import { TraceCollector } from "../../src/evaluation/trace-collector.js";

describe("TraceCollector", () => {
  it("按 runId 聚合终态 Trace 并只提交一次", async () => {
    const documents: TurnTraceDocument[] = [];
    const collector = new TraceCollector(async (document) => { documents.push(document); });
    const variant = fixtureVariant();
    const resolvedReasoning = fixtureReasoning();

    collector.emit({
      type: "turn_started",
      runId: "run-1",
      sessionId: "session-1",
      turnId: "turn-1",
      startedAt: 10,
      variant,
      resolvedReasoning,
    });
    collector.emit({
      type: "model_round_started",
      runId: "run-1",
      roundId: "round-1",
      index: 0,
      startedAt: 11,
      resolvedReasoning,
      context: { messages: [], truncatedSourceIds: [] },
    });
    collector.emit({
      type: "model_round_usage",
      runId: "run-1",
      roundId: "round-1",
      inputTokens: 100,
      outputTokens: 30,
      cachedInputTokens: 40,
      reasoningOutputTokens: 12,
    });
    collector.emit({
      type: "turn_completed",
      runId: "run-1",
      status: "completed",
      stopReason: "stop",
      completedAt: 20,
    });
    await collector.flush();

    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      sessionId: "session-1",
      turnId: "turn-1",
      modelRounds: [{
        context: { inputTokens: 100 },
        outputTokens: 30,
        cachedInputTokens: 40,
        reasoningOutputTokens: 12,
      }],
    });
    expect(collector.takeTrace("session-1", "turn-1")).toMatchObject({ turnId: "turn-1" });
    expect(collector.takeTrace("session-1", "turn-1")).toBeUndefined();
  });

  it("持久化失败不会从 emit 抛出并会在 flush 后释放名额", async () => {
    let attempts = 0;
    const collector = new TraceCollector(async () => {
      attempts += 1;
      throw new Error("disk offline");
    });

    expect(() => completeTurn(collector, "failed-write")).not.toThrow();
    await collector.flush();
    expect(attempts).toBe(1);
  });

  it("最多并行提交四条，超出的终态不建立无界等待队列", async () => {
    let releaseWrites: (() => void) | undefined;
    const release = new Promise<void>((resolve) => { releaseWrites = resolve; });
    let writes = 0;
    const collector = new TraceCollector(async () => {
      writes += 1;
      await release;
    });

    for (let index = 0; index < 5; index += 1) completeTurn(collector, `turn-${index}`);
    expect(writes).toBe(4);
    releaseWrites?.();
    await collector.flush();

    completeTurn(collector, "after-release");
    await collector.flush();
    expect(writes).toBe(5);
  });
});

function completeTurn(collector: TraceCollector, id: string): void {
  collector.emit({
    type: "turn_started",
    runId: id,
    sessionId: "session",
    turnId: id,
    startedAt: 1,
    variant: fixtureVariant(),
    resolvedReasoning: fixtureReasoning(),
  });
  collector.emit({
    type: "turn_completed",
    runId: id,
    status: "completed",
    completedAt: 2,
  });
}

function fixtureVariant() {
  return {
    studentId: "student",
    studentName: "Student",
    provider: "ollama",
    model: "qwen3:8b",
    systemPromptHash: "hash",
    runtimeVersion: "1.5",
    toolNames: [] as string[],
  };
}

function fixtureReasoning() {
  return {
    schemaVersion: 1 as const,
    requestedProfile: "balanced" as const,
    resolvedProfile: "balanced" as const,
    source: "model_default" as const,
    providerKind: "ollama",
    model: "qwen3:8b",
    native: { think: true },
  };
}
