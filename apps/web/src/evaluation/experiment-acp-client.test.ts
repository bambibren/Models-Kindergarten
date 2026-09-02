import { describe, expect, it } from "vitest";
import { readPromptMeta } from "@kindergarten/contracts";
import { elicitationFields, experimentPromptRequest } from "./experiment-acp-client.js";

describe("experiment ACP interventions", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("保留 AskUser 完整表单字段，而不是只取第一个字段", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
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

describe("experiment ACP prompt", () => {
  it("把首页引用的 Artifact ID 原样放入实验首轮 PromptMeta", () => {
    const request = experimentPromptRequest("session-a", "比较方案", "turn-a", [
      { artifactId: "artifact_first" },
      { artifactId: "artifact_second" },
    ]);

    expect(request.prompt).toEqual([{ type: "text", text: "比较方案" }]);
    expect(readPromptMeta(request._meta)).toEqual({
      schemaVersion: 1,
      turnId: "turn-a",
      artifactMentions: [{ artifactId: "artifact_first" }, { artifactId: "artifact_second" }],
    });
  });
});
