import { describe, expect, it, vi } from "vitest";
import { ContextAssembler } from "../src/conversation/context-assembler.js";
import { previewContextWindow } from "../src/conversation/context-window-preview.js";
import { FixtureProvider } from "../src/model/fixture-provider.js";
import type { SessionEntry } from "../src/repository/session-types.js";

describe("context window preview", () => {
  it("重组完整保留会话且不调用模型", async () => {
    const model = new FixtureProvider();
    model.student.contextWindowTokens = 128_000;
    const serialize = vi.spyOn(model, "serializeContext");
    const stream = vi.spyOn(model, "stream");
    const entries: SessionEntry[] = [
      message("user", "第一问", "m1", "t1"),
      message("assistant", "第一答", "m2", "t1"),
      {
        type: "thought", turnId: "t2", messageId: "thought-1", text: "不应进入上下文", createdAt: now(),
      },
      {
        type: "tool_call", turnId: "t2", toolCallId: "tool-1", title: "读取资料", name: "read_file",
        kind: "read", status: "completed", rawInput: { path: "a.txt" }, rawOutput: { content: "工具结果" },
        modelContent: "工具结果", outcomeStatus: "success", content: [], locations: [], createdAt: now(),
      },
      message("assistant", "刚完成的回答", "m3", "t2"),
      {
        type: "context_summary", turnId: "t2", createdAt: now(),
        summary: { schemaVersion: 1, turnId: "t2", items: [], totalEstimatedTokens: 999_999 },
      },
      {
        type: "token_usage", turnId: "t2", createdAt: now(),
        usage: { schemaVersion: 1, turnId: "t2", modelRequests: 2, inputTokens: 22_000, components: [] },
      },
      {
        type: "context_window_usage", turnId: "t2", createdAt: now(),
        state: { schemaVersion: 1, status: "available", afterTurnId: "t2", estimatedTokens: 77_777, windowTokens: 128_000, basis: "next_prompt_base" },
      },
    ];

    const result = await previewContextWindow({
      model,
      context: new ContextAssembler(),
      systemPrompt: "系统指令",
      tools: [],
      sessionEntries: entries,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({ windowTokens: 128_000, basis: "next_prompt_base" });
    expect(result?.estimatedTokens).toBeGreaterThan(0);
    expect(stream).not.toHaveBeenCalled();
    const messages = serialize.mock.calls.find(([fragment]) => fragment.kind === "messages")?.[0];
    expect(messages?.kind).toBe("messages");
    if (messages?.kind !== "messages") throw new Error("缺少 messages 序列化");
    expect(messages.messages).toMatchObject([
      { role: "user", content: "第一问" },
      { role: "assistant", content: "第一答" },
      { role: "assistant", toolCalls: [{ id: "tool-1", name: "read_file" }] },
      { role: "tool", content: "工具结果" },
      { role: "assistant", content: "刚完成的回答" },
      { role: "user", content: "" },
    ]);
    expect(JSON.stringify(messages.messages)).not.toContain("不应进入上下文");
    expect(JSON.stringify(messages.messages)).not.toContain("999999");
    expect(JSON.stringify(messages.messages)).not.toContain("22000");
    expect(JSON.stringify(messages.messages)).not.toContain("77777");
  });

  it("按下一次请求的历史预算裁剪旧消息，不累计历史请求 usage", async () => {
    const model = new FixtureProvider();
    model.student.contextWindowTokens = 8_000;
    const serialize = vi.spyOn(model, "serializeContext");
    const entries: SessionEntry[] = [
      message("user", "旧问题", "old-user", "t1"),
      message("assistant", "旧回答", "old-answer", "t1"),
      message("user", "新问题", "new-user", "t2"),
      message("assistant", "新回答", "new-answer", "t2"),
    ];

    await previewContextWindow({
      model,
      context: new ContextAssembler([], 3),
      systemPrompt: "系统指令",
      tools: [],
      sessionEntries: entries,
      signal: new AbortController().signal,
    });

    const fragment = serialize.mock.calls.find(([value]) => value.kind === "messages")?.[0];
    if (fragment?.kind !== "messages") throw new Error("缺少 messages 序列化");
    expect(fragment.messages.map((item) => item.content)).toEqual(["新问题", "新回答", ""]);
  });

  it("模型没有显式窗口时不生成假百分比", async () => {
    const model = new FixtureProvider();
    expect(await previewContextWindow({
      model,
      context: new ContextAssembler(),
      systemPrompt: "系统指令",
      tools: [],
      sessionEntries: [],
      signal: new AbortController().signal,
    })).toBeUndefined();
  });
});

function message(role: "user" | "assistant", text: string, messageId: string, turnId: string): SessionEntry {
  return { type: "message", role, text, messageId, turnId, createdAt: now() };
}

function now(): string {
  return "2026-08-18T00:00:00.000Z";
}
