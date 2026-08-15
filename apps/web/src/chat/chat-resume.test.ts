import { describe, expect, it } from "vitest";
import { makeAcpMeta } from "@kindergarten/contracts";
import { chatReducer, emptyChat } from "./chat-reducer.js";
import { sessionResumeMeta } from "./chat-resume.js";

describe("sessionResumeMeta", () => {
  it("分别计算消息和思考已接收长度及下一个 Chunk 序号", () => {
    let chat = chatReducer(emptyChat, { type: "session/open", sessionId: "session-1" });
    chat = chatReducer(chat, { type: "stream/start", operationId: "operation-1", source: "prompt", turnId: "turn-1" });
    chat = chatReducer(chat, { type: "acp/update", value: {
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "message-1",
        content: { type: "text", text: "第一段" },
        _meta: makeAcpMeta({ schemaVersion: 1, turnId: "turn-1", chunkIndex: 0 }),
      },
    } });
    chat = chatReducer(chat, { type: "acp/update", value: {
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "message-1",
        content: { type: "text", text: "第二段" },
        _meta: makeAcpMeta({ schemaVersion: 1, turnId: "turn-1", chunkIndex: 2 }),
      },
    } });
    chat = chatReducer(chat, { type: "acp/update", value: {
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_thought_chunk",
        messageId: "thought-1",
        content: { type: "text", text: "思考" },
        _meta: makeAcpMeta({ schemaVersion: 1, turnId: "turn-1", chunkIndex: 4 }),
      },
    } });

    expect(sessionResumeMeta(chat, "turn-1")).toEqual({
      schemaVersion: 1,
      turnId: "turn-1",
      messages: { "message-1": { textLength: 6, nextChunkIndex: 3 } },
      thoughts: { "thought-1": { textLength: 2, nextChunkIndex: 5 } },
    });
  });
});
