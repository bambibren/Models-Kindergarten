import { describe, expect, it } from "vitest";
import { elicitationFields } from "./experiment-acp-client.js";

describe("experiment ACP interventions", () => {
  it("保留 AskUser 完整表单字段，而不是只取第一个字段", () => {
    expect(elicitationFields({
      type: "object",
      required: ["goal", "count"],
      properties: {
        goal: { type: "string", title: "目标", description: "说明期望结果" },
        count: { type: "integer", title: "数量" },
        approved: { type: "boolean", title: "确认" },
        style: { type: "string", title: "风格", enum: ["简洁", "完整"] },
      },
    })).toEqual([
      { name: "goal", label: "目标", type: "string", required: true, description: "说明期望结果" },
      { name: "count", label: "数量", type: "number", required: true },
      { name: "approved", label: "确认", type: "boolean", required: false },
      { name: "style", label: "风格", type: "string", required: false, enumValues: ["简洁", "完整"] },
    ]);
  });
});
