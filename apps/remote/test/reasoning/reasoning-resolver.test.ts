import { describe, expect, it } from "vitest";
import { resolveReasoning } from "../../src/reasoning/reasoning-resolver.js";

const capability = {
  schemaVersion: 1 as const,
  control: "effort_levels" as const,
  adjustable: true,
  supportedProfiles: ["fast", "balanced", "deep", "max"] as const,
  defaultProfile: "balanced" as const,
};

describe("resolveReasoning", () => {
  it("Session 覆盖 ModelStudent 默认值，且保存实际 Provider 参数", () => {
    const result = resolveReasoning({
      providerKind: "openai-compatible",
      model: "gpt-5.5",
      capability: { ...capability, supportedProfiles: [...capability.supportedProfiles] },
      modelDefault: "balanced",
      sessionOverride: "max",
      native: (profile) => ({ effort: profile === "max" ? "xhigh" : profile }),
    });
    expect(result).toMatchObject({
      requestedProfile: "max",
      resolvedProfile: "max",
      source: "session_override",
      native: { effort: "xhigh" },
    });
  });

  it("没有 Session 覆盖时跟随 ModelStudent 默认", () => {
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
      native: (profile) => ({ level: profile }),
    })).toMatchObject({ requestedProfile: "auto", resolvedProfile: "deep", source: "model_default" });
  });

  it("Session 覆盖档位缺失时按最近能力收敛", () => {
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
      native: (profile) => ({ level: profile }),
    })).toMatchObject({ requestedProfile: "balanced", resolvedProfile: "fast", source: "session_override" });
  });
});
