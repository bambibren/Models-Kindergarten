import { describe, expect, it } from "vitest";
import {
  addPendingTurnInteraction,
  finishTurnState,
  initialTurnState,
  interruptTurnState,
  removePendingTurnInteraction,
  transitionActiveTurn,
} from "../../src/repository/turn-state-machine.js";

describe("Turn state machine", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("只允许沿真实执行边界推进，并允许模型与工具多轮往返", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const accepted = initialTurnState("turn-1");
    const preparing = transitionActiveTurn(accepted, "preparing_context");
    const streaming = transitionActiveTurn(preparing, "model_streaming");
    const tooling = transitionActiveTurn(streaming, "tool_execution");
    const waiting = addPendingTurnInteraction(tooling, permission("call-1"));
    expect(waiting.waitingFor).toEqual({ permission: 1, input: 0 });
    expect(/** 构造「toThrow」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => transitionActiveTurn(waiting, "model_streaming")).toThrow("pending interaction");
    const resolved = removePendingTurnInteraction(waiting, "permission:call-1");
    const nextRound = transitionActiveTurn(resolved, "model_streaming");
    const finalizing = transitionActiveTurn(nextRound, "finalizing");

    expect(finishTurnState(finalizing, "completed")).toEqual({
      schemaVersion: 1,
      turnId: "turn-1",
      status: "completed",
    });
  });

  it("拒绝跳过阶段、在非工具阶段等待用户和从终态回到活动态", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const accepted = initialTurnState("turn-2");
    expect(/** 构造「toThrow」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => transitionActiveTurn(accepted, "model_streaming")).toThrow("阶段转换无效");
    expect(/** 构造「toThrow」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => addPendingTurnInteraction(accepted, permission("call-2")))
      .toThrow("只有 tool_execution");
    expect(/** 构造「toThrow」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => finishTurnState(accepted, "failed")).toThrow("必须先进入 finalizing");

    const interrupted = interruptTurnState(accepted);
    expect(/** 构造「toThrow」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => transitionActiveTurn(interrupted, "preparing_context")).toThrow("Turn 已结束");
  });
});

/** 构造「permission」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function permission(toolCallId: string) {
  return {
    schemaVersion: 1 as const,
    interactionId: `permission:${toolCallId}`,
    kind: "permission" as const,
    toolCall: {
      toolCallId,
      title: "写入文件",
      name: "write_file",
      kind: "edit" as const,
      rawInput: { path: "index.html" },
      locations: [{ path: "/workspace/index.html" }],
    },
    options: [{ optionId: "allow-once", name: "允许", kind: "allow_once" as const }],
    requestedAt: "2026-08-17T00:00:00.000Z",
  };
}
