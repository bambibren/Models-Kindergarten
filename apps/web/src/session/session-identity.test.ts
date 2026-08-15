import { describe, expect, it } from "vitest";
import { ControlApiError } from "../api/control-api.js";
import { deletedAgentMessage, isMissingAgentError, projectSessionAvailability } from "./session-identity.js";

describe("session identity", () => {
  it("classifies only a missing Agent response as the deleted-Agent state", () => {
    expect(isMissingAgentError(new ControlApiError("NOT_FOUND", "Agent 不存在"))).toBe(true);
    expect(isMissingAgentError(new ControlApiError("VALIDATION_ERROR", "请求无效"))).toBe(false);
    expect(isMissingAgentError(new Error("网络失败"))).toBe(false);
  });

  it("keeps one explicit user-facing reason for disabling the Session composer", () => {
    expect(deletedAgentMessage).toBe("该会话绑定的 Agent 已删除，不能继续对话");
  });

  it("keeps Session navigation available while a deleted Agent disables only new prompts", () => {
    expect(projectSessionAvailability(true, true, "missing")).toEqual({
      navigationEnabled: true,
      promptEnabled: false,
    });
    expect(projectSessionAvailability(true, true, "available")).toEqual({
      navigationEnabled: true,
      promptEnabled: true,
    });
  });
});
