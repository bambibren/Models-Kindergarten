import type * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { promptTurnReducer } from "./prompt-turn-reducer.js";
import { idlePromptTurn, type PromptRequestState } from "./prompt-turn-types.js";

const request: PromptRequestState = {
  operationId: "operation-1",
  sessionId: "session-1",
  turnId: "turn-1",
  text: "测试 Prompt",
};

describe("prompt turn reducer", () => {
  it("用 order + byId 保存多个并发交互，并在全部处理后恢复 running", () => {
    let state = promptTurnReducer(idlePromptTurn, { type: "turn/start", request });
    state = promptTurnReducer(state, {
      type: "interaction/enqueue",
      interaction: permission("permission-1"),
    });
    state = promptTurnReducer(state, {
      type: "interaction/enqueue",
      interaction: permission("permission-2"),
    });

    expect(state.phase).toBe("waiting_for_user");
    if (state.phase !== "waiting_for_user") throw new Error("状态错误");
    expect(state.interactions.order).toEqual(["permission-1", "permission-2"]);

    state = promptTurnReducer(state, { type: "interaction/remove", id: "permission-1" });
    expect(state.phase).toBe("waiting_for_user");
    state = promptTurnReducer(state, { type: "interaction/remove", id: "permission-2" });
    expect(state).toMatchObject({ phase: "running", request });
  });

  it("只接受当前 operation 的终态，并由 reducer 生成稳定操作", () => {
    const running = promptTurnReducer(idlePromptTurn, { type: "turn/start", request });
    const stale = promptTurnReducer(running, {
      type: "turn/fail",
      operationId: "旧 operation",
      failure: { kind: "backend_error", message: "旧错误" },
    });
    expect(stale).toBe(running);

    const failed = promptTurnReducer(running, {
      type: "turn/fail",
      operationId: request.operationId,
      failure: { kind: "backend_error", message: "Ollama 不可用" },
    });
    expect(failed).toMatchObject({
      phase: "failed",
      failure: { kind: "backend_error", message: "Ollama 不可用" },
      actions: [{ type: "retry_prompt", label: "重试回答" }],
    });
  });

  it("连接失败和用户取消分别进入不同终态", () => {
    const running = promptTurnReducer(idlePromptTurn, { type: "turn/start", request });
    const disconnected = promptTurnReducer(running, {
      type: "turn/fail",
      operationId: request.operationId,
      failure: { kind: "connection_error", message: "连接已断开" },
    });
    expect(disconnected).toMatchObject({
      phase: "failed",
      actions: [{ type: "reconnect", label: "重新连接" }],
    });

    const cancelled = promptTurnReducer(running, {
      type: "turn/cancel",
      operationId: request.operationId,
    });
    expect(cancelled).toMatchObject({ phase: "cancelled", request });
  });
});

function permission(id: string) {
  const request: acp.RequestPermissionRequest = {
    sessionId: "session-1",
    toolCall: {
      toolCallId: id,
      title: "写入文件",
      kind: "edit",
      status: "pending",
      locations: [],
    },
    options: [],
  };
  return { id, kind: "permission" as const, request };
}
