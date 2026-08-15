import { describe, expect, it } from "vitest";
import { makeSessionResumeMeta, readSessionResumeMeta } from "./session-resume.js";

describe("SessionResumeMeta", () => {
  it("保留当前 Turn 的消息偏移与下一个 Chunk 序号", () => {
    const value = {
      schemaVersion: 1 as const,
      turnId: "turn-1",
      messages: { "message-1": { textLength: 12, nextChunkIndex: 3 } },
      thoughts: { "thought-1": { textLength: 8, nextChunkIndex: 2 } },
    };
    expect(readSessionResumeMeta(makeSessionResumeMeta(value))).toEqual(value);
  });

  it("拒绝负数、小数和缺失的游标字段", () => {
    expect(readSessionResumeMeta(makeSessionResumeMeta({
      schemaVersion: 1,
      turnId: "turn-1",
      messages: { "message-1": { textLength: -1, nextChunkIndex: 0 } },
      thoughts: {},
    }))).toBeUndefined();
    expect(readSessionResumeMeta(makeSessionResumeMeta({
      schemaVersion: 1,
      turnId: "turn-1",
      messages: {},
      thoughts: { "thought-1": { textLength: 1, nextChunkIndex: 1.5 } },
    }))).toBeUndefined();
    expect(readSessionResumeMeta({ modelKindergarten: {
      sessionResume: { schemaVersion: 1, turnId: "turn-1", messages: {}, thoughts: { "thought-1": { textLength: 1 } } },
    } })).toBeUndefined();
  });
});
