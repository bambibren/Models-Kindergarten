import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_SYSTEM_PROMPT,
  removeLegacyModelIdentity,
} from "../../src/agent/default-agent-system-prompt.js";

describe("default Agent system prompt", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("不向 Session 绑定的模型注入参数规模或本地 Provider 身份", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).not.toMatch(/\b8B\b|本地\s*ModelStudent/i);
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain("当前 Session 的 AI 助手");
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).not.toContain("终端");
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).not.toContain("run_command");
  });

  it("只替换旧默认身份句并保留用户后续配置", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const legacy = "你是 Models Kindergarten 中的本地 8B ModelStudent。保留这段工具规则。";
    expect(removeLegacyModelIdentity(legacy)).toBe(
      "你是 Models Kindergarten 中当前 Session 的 AI 助手。保留这段工具规则。",
    );
    expect(removeLegacyModelIdentity("你是自定义 Agent。不要修改。")).toBe("你是自定义 Agent。不要修改。");
  });
});
