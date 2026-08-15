import { describe, expect, it } from "vitest";
import { RepeatedInvalidToolCallGuard } from "../../src/runtime/repeated-invalid-tool-call-guard.js";
import type { PreparedToolCall, ToolOutcome } from "../../src/tools/tool-registry.js";

describe("RepeatedInvalidToolCallGuard", () => {
  it("只在第三个模型轮再次出现同工具同参数错误时终止", () => {
    const guard = new RepeatedInvalidToolCallGuard(3);

    expect(guard.inspect(0, [call("read_file", { pathName: "a.txt", extra: true })], [invalid()]))
      .toBeUndefined();
    expect(guard.inspect(1, [call("read_file", { extra: true, pathName: "a.txt" })], [invalid()]))
      .toBeUndefined();
    expect(guard.inspect(2, [call("read_file", { pathName: "a.txt", extra: true })], [invalid()]))
      .toMatchObject({ toolName: "read_file", attempts: 3, maxAttempts: 3 });
  });

  it("同一模型轮的并行重复调用只累计一次", () => {
    const guard = new RepeatedInvalidToolCallGuard(3);
    const calls = [
      call("activate_skill", { skillName: "frontend-design" }),
      call("activate_skill", { skillName: "frontend-design" }),
      call("activate_skill", { skillName: "frontend-design" }),
    ];

    expect(guard.inspect(0, calls, calls.map(() => invalid()))).toBeUndefined();
    expect(guard.inspect(1, [calls[0]!], [invalid()])).toBeUndefined();
    expect(guard.inspect(2, [calls[0]!], [invalid()])).toMatchObject({ attempts: 3 });
  });

  it("不同参数值分别计数且成功会清除对应签名", () => {
    const guard = new RepeatedInvalidToolCallGuard(3);
    const first = call("activate_skill", { skillName: "frontend-design" });
    const second = call("activate_skill", { skillName: "design-brief" });

    expect(guard.inspect(0, [first, second], [invalid(), invalid()])).toBeUndefined();
    expect(guard.inspect(1, [first, second], [invalid(), invalid()])).toBeUndefined();
    expect(guard.inspect(2, [first], [success()])).toBeUndefined();
    expect(guard.inspect(3, [first], [invalid()])).toBeUndefined();
    expect(guard.inspect(4, [second], [invalid()])).toMatchObject({
      toolName: "activate_skill",
      arguments: { skillName: "design-brief" },
      attempts: 3,
    });
  });

  it("新的 Guard 实例不会继承上一个用户 Turn 的计数", () => {
    const current = new RepeatedInvalidToolCallGuard(3);
    const next = new RepeatedInvalidToolCallGuard(3);
    const repeated = call("read_file", { fileName: "a.txt" });

    current.inspect(0, [repeated], [invalid()]);
    current.inspect(1, [repeated], [invalid()]);
    expect(next.inspect(0, [repeated], [invalid()])).toBeUndefined();
  });
});

function call(name: string, args: Record<string, unknown>): PreparedToolCall {
  return {
    id: `${name}:${JSON.stringify(args)}`,
    name,
    title: name,
    kind: "other",
    arguments: structuredClone(args),
    permission: "allow",
    locations: [],
    dedupeKey: `${name}:${JSON.stringify(args)}`,
    retry: "none",
  };
}

function invalid(): ToolOutcome {
  return {
    status: "error",
    retryable: false,
    error: { code: "invalid_arguments", category: "validation", message: "参数错误" },
    modelContent: "参数错误",
    rawOutput: {},
    content: [],
    locations: [],
  };
}

function success(): ToolOutcome {
  return {
    status: "success",
    retryable: false,
    modelContent: "ok",
    rawOutput: {},
    content: [],
    locations: [],
  };
}
