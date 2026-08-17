import type { SessionNotification, SessionUpdate } from "@agentclientprotocol/sdk";
import { makeAcpMeta } from "@kindergarten/contracts";
import { describe, expect, it } from "vitest";
import { chatReducer, emptyChat } from "./chat-reducer.js";

describe("chatReducer", () => {
  it("在 PromptResponse 前只更新 streamingChatEntries，结束后整体提交", () => {
    let state = openStream("prompt", [{ type: "text", text: "你好" }]);

    state = chatReducer(state, {
      type: "acp/update",
      value: messageNotice("user", "user-agent-id", "你好", 0, true),
    });
    state = chatReducer(state, {
      type: "context/summary",
      value: {
        sessionId: "session-1",
        summary: {
          schemaVersion: 1,
          turnId: "turn-1",
          items: [{
            id: "system-prompt",
            kind: "system_instruction",
            title: "Agent 基础指令",
            estimatedTokens: 12,
          }],
          totalEstimatedTokens: 12,
        },
      },
    });
    state = chatReducer(state, {
      type: "acp/update",
      value: messageNotice("assistant", "assistant-1", "你", 0),
    });
    state = chatReducer(state, {
      type: "acp/update",
      value: messageNotice("assistant", "assistant-1", "重复", 0),
    });
    state = chatReducer(state, {
      type: "acp/update",
      value: messageNotice("assistant", "assistant-1", "好", 1),
    });
    state = chatReducer(state, {
      type: "acp/update",
      value: messageNotice("assistant", "assistant-1", "", 2, true),
    });
    state = chatReducer(state, {
      type: "token/usage",
      value: {
        sessionId: "session-1",
        usage: {
          schemaVersion: 1,
          turnId: "turn-1",
          modelRequests: 1,
          inputTokens: 18,
          outputTokens: 7,
          components: [
            {
              category: "current_prompt",
              targetType: "message",
              targetId: "user-agent-id",
              estimatedTokens: 1,
            },
            {
              category: "answer",
              targetType: "message",
              targetId: "assistant-1",
              estimatedTokens: 1,
            },
          ],
        },
      },
    });

    expect(state.historyChatEntries.order).toHaveLength(0);
    expect(values(state.streamingChatEntries)).toMatchObject([
      {
        type: "message",
        messageId: "user-agent-id",
        status: "done",
        tokenEstimate: { category: "current_prompt", estimatedTokens: 1 },
      },
      { type: "context_summary", turnId: "turn-1" },
      {
        type: "message",
        messageId: "assistant-1",
        status: "done",
        content: [{ type: "text", text: "你好" }],
        tokenEstimate: { category: "answer", estimatedTokens: 1 },
      },
      { type: "token_usage", usage: { inputTokens: 18, outputTokens: 7 } },
    ]);

    state = chatReducer(state, {
      type: "stream/commit",
      operationId: "operation-1",
    });
    expect(state.historyChatEntries.order).toHaveLength(4);
    expect(state.streamingChatEntries.order).toHaveLength(0);
    expect(state.streaming).toBeNull();
  });

  it("并行 Tool 按首次出现顺序就地更新，不按完成顺序重排", () => {
    let state = openStream("load");
    state = update(state, {
      sessionUpdate: "tool_call",
      toolCallId: "tool-a",
      title: "工具 A",
      kind: "search",
      status: "in_progress",
    });
    state = update(state, {
      sessionUpdate: "tool_call",
      toolCallId: "tool-b",
      title: "工具 B",
      kind: "fetch",
      status: "in_progress",
    });
    state = update(state, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-b",
      status: "completed",
      rawOutput: { result: "B 先完成" },
    });

    expect(values(state.streamingChatEntries)).toMatchObject([
      { type: "tool_call", toolCallId: "tool-a", status: "in_progress" },
      { type: "tool_call", toolCallId: "tool-b", status: "completed" },
    ]);

    state = update(state, {
      sessionUpdate: "agent_message_chunk",
      messageId: "message-after-tools",
      content: { type: "text", text: "B 已返回，继续等待 A。" },
      _meta: makeAcpMeta({
        schemaVersion: 1,
        turnId: "turn-1",
        chunkIndex: 0,
        final: true,
      }),
    });
    state = update(state, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-a",
      status: "completed",
      rawOutput: { result: "A 后完成" },
    });

    expect(state.streamingChatEntries.order).toEqual([
      "tool:tool-a",
      "tool:tool-b",
      "message:message-after-tools",
    ]);
  });

  it("允许 tool_call_update 先到并在原位置补全", () => {
    let state = openStream("load");
    state = update(state, {
      sessionUpdate: "tool_call_update",
      toolCallId: "late-tool",
      status: "in_progress",
      rawInput: { query: "ACP" },
    });
    state = update(state, {
      sessionUpdate: "tool_call",
      toolCallId: "late-tool",
      title: "搜索 ACP",
      kind: "search",
      status: "in_progress",
    });
    expect(values(state.streamingChatEntries)).toMatchObject([
      {
        type: "tool_call",
        toolCallId: "late-tool",
        title: "搜索 ACP",
        rawInput: { query: "ACP" },
      },
    ]);
  });

  it("忽略其他 session 的消息", () => {
    const state = chatReducer(openStream("load"), {
      type: "acp/update",
      value: {
        ...messageNotice("assistant", "message-1", "串线", 0, true),
        sessionId: "session-2",
      },
    });
    expect(state.streamingChatEntries.order).toHaveLength(0);
  });

  it("load 恢复活动 Turn 后继续接收授权后的工具更新和回复", () => {
    let state = openStream("load");
    state = update(state, {
      sessionUpdate: "tool_call",
      toolCallId: "write-after-wait",
      title: "写入 index.html",
      name: "write_file",
      kind: "edit",
      status: "pending",
    });
    state = chatReducer(state, {
      type: "stream/load-complete",
      operationId: "operation-1",
      activeTurn: { operationId: "remote:session-1:turn-1", turnId: "turn-1" },
    });

    expect(state.streaming?.operationId).toBe("remote:session-1:turn-1");
    expect(state.streamingChatEntries.order).toEqual(["tool:write-after-wait"]);
    expect(state.historyChatEntries.order).toEqual([]);

    state = update(state, {
      sessionUpdate: "tool_call_update",
      toolCallId: "write-after-wait",
      status: "completed",
      content: [{
        type: "content",
        content: {
          type: "resource_link",
          name: "index.html",
          uri: "mk-file://file-after-wait",
        },
      }],
    });
    state = chatReducer(state, {
      type: "acp/update",
      value: messageNotice("assistant", "answer-after-wait", "修改完成", 0, true),
    });
    state = chatReducer(state, {
      type: "stream/commit",
      operationId: "remote:session-1:turn-1",
    });

    expect(values(state.historyChatEntries)).toMatchObject([
      {
        type: "tool_call",
        toolCallId: "write-after-wait",
        status: "completed",
        content: [{ content: { type: "resource_link", uri: "mk-file://file-after-wait" } }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "修改完成" }],
      },
    ]);
    expect(state.streaming).toBeNull();
  });

  it("提交旧流后可以开始新的 streamingEntries", () => {
    let state = openStream("prompt", [{ type: "text", text: "上一轮" }]);
    state = chatReducer(state, {
      type: "stream/commit",
      operationId: "operation-1",
    });
    expect(state.streaming).toBeNull();
    state = chatReducer(state, {
      type: "stream/start",
      operationId: "operation-2",
      source: "prompt",
      turnId: "turn-2",
      optimisticContent: [{ type: "text", text: "新一轮" }],
    });
    expect(state.streaming?.operationId).toBe("operation-2");
  });
});

function openStream(
  source: "prompt" | "load",
  optimisticContent?: Array<{ type: "text"; text: string }>,
) {
  let state = chatReducer(emptyChat, {
    type: "session/open",
    sessionId: "session-1",
  });
  state = chatReducer(state, {
    type: "stream/start",
    operationId: "operation-1",
    source,
    turnId: "turn-1",
    ...(optimisticContent ? { optimisticContent } : {}),
  });
  return state;
}

function values(collection: ReturnType<typeof openStream>["streamingChatEntries"]) {
  return collection.order.map((id) => collection.byId[id]);
}

function update(state: ReturnType<typeof openStream>, value: SessionUpdate) {
  return chatReducer(state, {
    type: "acp/update",
    value: { sessionId: "session-1", update: value },
  });
}

function messageNotice(
  role: "user" | "assistant",
  messageId: string,
  text: string,
  chunkIndex: number,
  final = false,
): SessionNotification {
  return {
    sessionId: "session-1",
    update: {
      sessionUpdate:
        role === "user" ? "user_message_chunk" : "agent_message_chunk",
      content: { type: "text", text },
      messageId,
      _meta: makeAcpMeta({
        schemaVersion: 1,
        turnId: "turn-1",
        chunkIndex,
        final,
      }),
    },
  };
}
