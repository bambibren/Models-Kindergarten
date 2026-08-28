import { describe, expect, it } from "vitest";
import { resolveReasoning } from "../../src/reasoning/reasoning-resolver.js";

const capability = {
  schemaVersion: 1 as const,
  control: "effort_levels" as const,
  adjustable: true,
  supportedProfiles: ["fast", "balanced", "deep", "max"] as const,
  defaultProfile: "balanced" as const,
};

describe("resolveReasoning", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("Session 覆盖 ModelStudent 默认值，且保存实际 Provider 参数", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const result = resolveReasoning({
      providerKind: "openai-compatible",
      model: "gpt-5.5",
      capability: { ...capability, supportedProfiles: [...capability.supportedProfiles] },
      modelDefault: "balanced",
      sessionOverride: "max",
      native: /** 构造「native」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(profile) => ({ effort: profile === "max" ? "xhigh" : profile }),
    });
    expect(result).toMatchObject({
      requestedProfile: "max",
      resolvedProfile: "max",
      source: "session_override",
      native: { effort: "xhigh" },
    });
  });

  it("没有 Session 覆盖时跟随 ModelStudent 默认", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    expect(resolveReasoning({
      providerKind: "example",
      model: "fixed-model",
      capability: {
        schemaVersion: 1,
        control: "effort_levels",
        adjustable: true,
        supportedProfiles: ["fast", "deep"],
        defaultProfile: "deep",
      },
      modelDefault: "deep",
      native: /** 构造「native」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(profile) => ({ level: profile }),
    })).toMatchObject({ requestedProfile: "auto", resolvedProfile: "deep", source: "model_default" });
  });

  it("Session 覆盖档位缺失时按最近能力收敛", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    expect(resolveReasoning({
      providerKind: "example",
      model: "limited-model",
      capability: {
        schemaVersion: 1,
        control: "effort_levels",
        adjustable: true,
        supportedProfiles: ["fast", "deep"],
        defaultProfile: "deep",
      },
      modelDefault: "deep",
      sessionOverride: "balanced",
      native: /** 构造「native」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(profile) => ({ level: profile }),
    })).toMatchObject({ requestedProfile: "balanced", resolvedProfile: "fast", source: "session_override" });
  });
});
