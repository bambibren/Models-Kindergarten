import { describe, expect, it } from "vitest";
import { readTurnState, readTurnStateNotification } from "./turn-state.js";

describe("Turn state contract", () => {
  it("解析活动阶段和并发等待计数", () => {
    expect(readTurnState({
      schemaVersion: 1,
      turnId: "turn-1",
      status: "active",
      phase: "tool_execution",
      waitingFor: { permission: 2, input: 1 },
    })).toMatchObject({ status: "active", phase: "tool_execution", waitingFor: { permission: 2, input: 1 } });
  });

  it("拒绝旧 running、负计数和缺少 sessionId 的通知", () => {
    expect(() => readTurnState({ schemaVersion: 1, turnId: "turn-1", status: "running" })).toThrow("终态无效");
    expect(() => readTurnState({
      schemaVersion: 1,
      turnId: "turn-1",
      status: "active",
      phase: "tool_execution",
      waitingFor: { permission: -1, input: 0 },
    })).toThrow("活动 Turn 状态格式无效");
    expect(() => readTurnStateNotification({ turn: { schemaVersion: 1 } })).toThrow("sessionId");
  });
});
