import { describe, expect, it } from "vitest";
import { ModelOutputLifecycle } from "../../src/runtime/model-output-lifecycle.js";

describe("ModelOutputLifecycle", () => {
  it("按显式边界聚合 reasoning、message 和 tool call", () => {
    const lifecycle = new ModelOutputLifecycle();
    lifecycle.start({ id: "reasoning-1", kind: "reasoning" });
    lifecycle.delta("reasoning-1", { kind: "text", text: "先分析" });
    lifecycle.complete({ id: "reasoning-1", kind: "reasoning", text: "先分析" });
    lifecycle.start({ id: "message-1", kind: "message" });
    lifecycle.delta("message-1", { kind: "text", text: "开始写入" });
    lifecycle.complete({ id: "message-1", kind: "message", text: "开始写入" });
    lifecycle.start({ id: "tool-item-1", kind: "tool_call", callId: "call-1", name: "write_file" });
    lifecycle.delta("tool-item-1", { kind: "tool_arguments", text: "{\"path\":\"index.html\"}" });
    lifecycle.complete({
      id: "tool-item-1",
      kind: "tool_call",
      call: { id: "call-1", name: "write_file", arguments: { path: "index.html" } },
    });

    expect(lifecycle.snapshot()).toEqual({
      content: "开始写入",
      thinking: "先分析",
      calls: [{ id: "call-1", name: "write_file", arguments: { path: "index.html" } }],
    });
  });

  it("拒绝未知 item、重复完成和响应结束时仍开放的 item", () => {
    const unknown = new ModelOutputLifecycle();
    expect(() => unknown.delta("missing", { kind: "text", text: "x" })).toThrow("尚未开始");

    const duplicate = new ModelOutputLifecycle();
    duplicate.start({ id: "message-1", kind: "message" });
    duplicate.complete({ id: "message-1", kind: "message", text: "done" });
    expect(() => duplicate.complete({ id: "message-1", kind: "message", text: "again" })).toThrow("完成后仍收到事件");

    const open = new ModelOutputLifecycle();
    open.start({ id: "reasoning-1", kind: "reasoning" });
    expect(() => open.snapshot()).toThrow("仍有未完成 item");
  });

  it("拒绝在工具完成时替换 Provider callId", () => {
    const lifecycle = new ModelOutputLifecycle();
    lifecycle.start({ id: "tool-item", kind: "tool_call", callId: "call-a" });
    expect(() => lifecycle.complete({
      id: "tool-item",
      kind: "tool_call",
      call: { id: "call-b", name: "read_file", arguments: { path: "a.txt" } },
    })).toThrow("callId 在完成时发生变化");
  });
});
