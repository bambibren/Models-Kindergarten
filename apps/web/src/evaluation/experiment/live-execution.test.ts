import { describe, expect, it } from "vitest";
import type { LiveExecutionEvent, LiveExecutionEventData } from "@kindergarten/contracts";
import { finishLiveExecution, reduceLiveExecution, startLiveExecution, toLiveDemoExecution } from "./live-execution.js";

describe("实验实时执行轨迹", () => {
  it("Session 创建后立即显示准备节点，避免执行 Tab 空白", () => {
    const execution = toLiveDemoExecution(startLiveExecution("turn-a", 1_000), 1_350);
    expect(execution.trace).toEqual([expect.objectContaining({
      type: "result",
      status: "running",
      title: "正在准备 Runtime 上下文",
      duration: "350 ms",
    })]);
  });

  it("在同一节点上更新耗时，并保留失败 Attempt 与后续重试", () => {
    let state = startLiveExecution("turn-a", 1_000);
    state = apply(state, {
      type: "model_round_started", roundIndex: 0, startedAt: 1_100,
    }, 0);
    state = apply(state, {
      type: "model_attempt_started", roundIndex: 0, attemptId: "attempt-0", attemptIndex: 0, maxAttempts: 6, startedAt: 1_200,
    }, 1);

    let execution = toLiveDemoExecution(state, 1_700);
    expect(execution.trace[0]).toMatchObject({ status: "running", duration: "500 ms", attemptIndex: 0 });

    state = apply(state, {
      type: "model_attempt_failed", roundIndex: 0, attemptId: "attempt-0", attemptIndex: 0, completedAt: 1_800,
      error: { code: "MODEL_TRANSPORT_ERROR", message: "Provider 连接中断", retryable: true }, retryDelayMs: 500,
    }, 2);
    state = apply(state, {
      type: "model_attempt_started", roundIndex: 0, attemptId: "attempt-1", attemptIndex: 1, maxAttempts: 6, startedAt: 2_300,
    }, 3);

    execution = toLiveDemoExecution(state, 2_500);
    expect(execution.modelRounds).toBe(1);
    expect(execution.retryCount).toBe(1);
    expect(execution.trace).toHaveLength(2);
    expect(execution.trace[0]).toMatchObject({ status: "failed", retryDelay: "500 ms" });
    expect(execution.trace[1]).toMatchObject({ status: "running", attemptIndex: 1, duration: "200 ms" });
  });

  it("实时更新工具终态，并忽略重复或晚到事件", () => {
    let state = startLiveExecution("turn-a", 1_000);
    state = apply(state, {
      type: "tool_call_started", roundIndex: 1, toolCallId: "tool-a", name: "read_file", title: "读取文件", startedAt: 2_000,
    }, 4);
    const unchanged = apply(state, {
      type: "model_round_started", roundIndex: 0, startedAt: 1_100,
    }, 3);
    expect(unchanged).toBe(state);

    state = apply(state, {
      type: "tool_call_completed", roundIndex: 1, toolCallId: "tool-a", completedAt: 2_450, status: "success",
    }, 5);
    const execution = toLiveDemoExecution(state, 3_000);
    expect(execution.toolCalls).toBe(1);
    expect(execution.trace[0]).toMatchObject({ type: "tool", status: "completed", duration: "450 ms" });
  });

  it("收到单个 Turn 终态后立即冻结总耗时和未闭合节点", () => {
    let state = startLiveExecution("turn-a", 1_000);
    state = apply(state, {
      type: "model_attempt_started", roundIndex: 0, attemptId: "attempt-0", attemptIndex: 0, maxAttempts: 6, startedAt: 1_200,
    }, 0);
    state = finishLiveExecution(state, {
      schemaVersion: 1,
      turnId: "turn-a",
      status: "completed",
    }, 3_000);

    const execution = toLiveDemoExecution(state, 10_000);
    expect(execution.duration).toBe("2.0 s");
    expect(execution.trace[0]).toMatchObject({
      status: "completed",
      duration: "1.8 s",
      detail: "Turn 已结束，正在读取最终执行记录",
    });

    const unchanged = apply(state, {
      type: "model_attempt_completed", roundIndex: 0, attemptId: "attempt-0", attemptIndex: 0, completedAt: 4_000,
    }, 1);
    expect(unchanged).toBe(state);
  });
});

function apply(
  state: ReturnType<typeof startLiveExecution>,
  data: LiveExecutionEventData,
  sequence: number,
) {
  return reduceLiveExecution(state, { schemaVersion: 1, turnId: state.turnId, sequence, ...data } as LiveExecutionEvent);
}
