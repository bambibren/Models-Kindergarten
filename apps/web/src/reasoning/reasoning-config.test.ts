import { describe, expect, it } from "vitest";
import type { ModelReasoningCapability } from "@kindergarten/contracts";
import { availableReasoningProfiles, profileLabel, projectReasoningConfig, reasoningAutoLabel } from "./reasoning-config.js";

const adjustable: ModelReasoningCapability = {
  schemaVersion: 1,
  control: "effort_levels",
  adjustable: true,
  supportedProfiles: ["balanced", "deep", "max"],
  defaultProfile: "balanced",
};

describe("reasoning config projection", () => {
  it("projects the ACP thought_level option and filters unsupported provider values", () => {
    expect(projectReasoningConfig([{
      type: "select",
      id: "reasoning_profile",
      name: "思考强度",
      category: "thought_level",
      currentValue: "deep",
      options: [
        { value: "auto", name: "自动" },
        { value: "fast", name: "快速" },
        { value: "balanced", name: "均衡" },
        { value: "deep", name: "深入" },
        { value: "max", name: "极致" },
      ],
    }], adjustable)).toEqual({
      configId: "reasoning_profile",
      currentProfile: "deep",
      choices: [
        { profile: "auto", name: "跟随模型默认 · 均衡" },
        { profile: "balanced", name: "均衡" },
        { profile: "deep", name: "深入" },
        { profile: "max", name: "极致" },
      ],
    });
  });

  it("supports grouped ACP options", () => {
    expect(projectReasoningConfig([{
      type: "select",
      id: "reasoning_profile",
      name: "思考强度",
      category: "thought_level",
      currentValue: "balanced",
      options: [{ group: "common", name: "常用", options: [
        { value: "auto", name: "自动" },
        { value: "balanced", name: "均衡" },
      ] }],
    }], adjustable)?.choices.map((choice) => choice.profile)).toEqual(["auto", "balanced"]);
  });

  it("does not expose a control for fixed models or malformed ACP state", () => {
    const fixed: ModelReasoningCapability = {
      schemaVersion: 1,
      control: "fixed",
      adjustable: false,
      supportedProfiles: ["balanced"],
      defaultProfile: "balanced",
    };
    expect(projectReasoningConfig([], fixed)).toBeUndefined();
    expect(availableReasoningProfiles(fixed)).toEqual([]);
    expect(projectReasoningConfig([{
      type: "select", id: "other", name: "Other", category: "model", currentValue: "deep",
      options: [{ value: "deep", name: "深入" }],
    }], adjustable)).toBeUndefined();
  });

  it("labels a boolean reasoning control as off/on instead of fake effort levels", () => {
    const toggle: ModelReasoningCapability = {
      schemaVersion: 1,
      control: "toggle",
      adjustable: true,
      supportedProfiles: ["fast", "balanced"],
      defaultProfile: "balanced",
      native: { parameter: "think", values: ["false", "true"] },
    };
    expect(profileLabel("fast", toggle)).toBe("关闭思考");
    expect(profileLabel("balanced", toggle)).toBe("开启思考");
    expect(availableReasoningProfiles(toggle)).toEqual(["auto", "fast", "balanced"]);
    expect(reasoningAutoLabel(toggle)).toBe("跟随模型默认 · 开启思考");
  });

  it("shows the selected ModelStudent default on the auto choice", () => {
    expect(reasoningAutoLabel(adjustable)).toBe("跟随模型默认 · 均衡");
    expect(reasoningAutoLabel()).toBe("跟随模型默认");
  });
});
