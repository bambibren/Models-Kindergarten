import { describe, expect, it } from "vitest";
import { readTurnState, readTurnStateNotification } from "./turn-state.js";

describe("Turn state contract", () => {
  it("解析活动阶段和并发等待计数", () => {
    const state = readTurnState({
      schemaVersion: 1,
      turnId: "turn-1",
      status: "active",
      phase: "tool_execution",
      waitingFor: { permission: 2, input: 1 },
      pendingInteractions: [permission("p-1"), permission("p-2"), elicitation("q-1")],
    });
    expect(state).toMatchObject({
      status: "active",
      phase: "tool_execution",
      waitingFor: { permission: 2, input: 1 },
    });
    expect(state.status === "active" ? state.pendingInteractions.map((item) => item.interactionId) : [])
      .toEqual(["permission:p-1", "permission:p-2", "elicitation:q-1"]);
  });

  it("拒绝旧 running、派生计数不一致和缺少 sessionId 的通知", () => {
    expect(() => readTurnState({ schemaVersion: 1, turnId: "turn-1", status: "running" })).toThrow("终态无效");
    expect(() => readTurnState({
      schemaVersion: 1,
      turnId: "turn-1",
      status: "active",
      phase: "tool_execution",
      waitingFor: { permission: 0, input: 0 },
      pendingInteractions: [permission("p-1")],
    })).toThrow("不一致");
    expect(() => readTurnStateNotification({ turn: { schemaVersion: 1 } })).toThrow("sessionId");
  });
});

function permission(toolCallId: string) {
  return {
    schemaVersion: 1,
    interactionId: `permission:${toolCallId}`,
    kind: "permission",
    toolCall: {
      toolCallId,
      title: "写入文件",
      name: "write_file",
      kind: "edit",
      rawInput: { path: "index.html" },
      locations: [{ path: "/workspace/index.html" }],
    },
    options: [
      { optionId: "allow-once", name: "允许本次执行", kind: "allow_once" },
      { optionId: "reject-once", name: "拒绝本次执行", kind: "reject_once" },
    ],
    requestedAt: "2026-08-17T00:00:00.000Z",
  };
}

function elicitation(toolCallId: string) {
  return {
    schemaVersion: 1,
    interactionId: `elicitation:${toolCallId}`,
    kind: "elicitation",
    toolCallId,
    message: "请选择颜色",
    requestedSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
    requestedAt: "2026-08-17T00:00:00.000Z",
  };
}
