import { describe, expect, it } from "vitest";
import {
  finishTurnState,
  initialTurnState,
  interruptTurnState,
  transitionActiveTurn,
} from "../../src/repository/turn-state-machine.js";

describe("Turn state machine", () => {
  it("只允许沿真实执行边界推进，并允许模型与工具多轮往返", () => {
    const accepted = initialTurnState("turn-1");
    const preparing = transitionActiveTurn(accepted, "preparing_context");
    const streaming = transitionActiveTurn(preparing, "model_streaming");
    const tooling = transitionActiveTurn(streaming, "tool_execution", { permission: 2, input: 1 });
    const nextRound = transitionActiveTurn(tooling, "model_streaming");
    const finalizing = transitionActiveTurn(nextRound, "finalizing");

    expect(finishTurnState(finalizing, "completed")).toEqual({
      schemaVersion: 1,
      turnId: "turn-1",
      status: "completed",
    });
  });

  it("拒绝跳过阶段、在非工具阶段等待用户和从终态回到活动态", () => {
    const accepted = initialTurnState("turn-2");
    expect(() => transitionActiveTurn(accepted, "model_streaming")).toThrow("阶段转换无效");
    expect(() => transitionActiveTurn(accepted, "accepted", { permission: 1, input: 0 }))
      .toThrow("只有 tool_execution");
    expect(() => finishTurnState(accepted, "failed")).toThrow("必须先进入 finalizing");

    const interrupted = interruptTurnState(accepted);
    expect(() => transitionActiveTurn(interrupted, "preparing_context")).toThrow("Turn 已结束");
  });
});
