import { describe, expect, it } from "vitest";
import { readLiveExecutionNotification } from "./execution-trace-stream.js";

describe("实时执行轨迹通知", () => {
  it("保留模型失败、重试等待和调用序号", () => {
    expect(readLiveExecutionNotification({
      sessionId: "session-a",
      event: {
        schemaVersion: 1,
        turnId: "turn-a",
        sequence: 3,
        type: "model_attempt_failed",
        roundIndex: 0,
        attemptId: "attempt-a",
        attemptIndex: 0,
        completedAt: 2_000,
        error: { code: "MODEL_TRANSPORT_ERROR", message: "连接中断", retryable: true },
        retryDelayMs: 500,
      },
    }).event).toMatchObject({
      type: "model_attempt_failed",
      sequence: 3,
      attemptIndex: 0,
      retryDelayMs: 500,
    });
  });

  it("拒绝非法 sequence 和不完整工具终态", () => {
    expect(() => readLiveExecutionNotification({
      sessionId: "session-a",
      event: { schemaVersion: 1, turnId: "turn-a", sequence: -1, type: "model_round_started", roundIndex: 0, startedAt: 1 },
    })).toThrow("执行轨迹事件");
    expect(() => readLiveExecutionNotification({
      sessionId: "session-a",
      event: { schemaVersion: 1, turnId: "turn-a", sequence: 0, type: "tool_call_completed", roundIndex: 0, toolCallId: "tool-a", completedAt: 2 },
    })).toThrow("工具状态");
  });
});
