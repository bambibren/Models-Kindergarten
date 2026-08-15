import { describe, expect, it } from "vitest";
import {
  parseReasoningProfile,
  readModelReasoningCapability,
  resolveSupportedReasoningProfile,
} from "./reasoning.js";

describe("reasoning contracts", () => {
  it("只接受稳定的产品级推理档位", () => {
    expect(parseReasoningProfile("deep")).toBe("deep");
    expect(() => parseReasoningProfile("xhigh")).toThrow("auto、fast、balanced、deep 或 max");
  });

  it("拒绝能力默认值、可调标记和档位集合互相矛盾", () => {
    expect(readModelReasoningCapability({
      schemaVersion: 1,
      control: "effort_levels",
      adjustable: true,
      supportedProfiles: ["fast", "balanced", "deep", "max"],
      defaultProfile: "balanced",
      native: { parameter: "reasoning.effort", values: ["low", "medium", "high", "xhigh"] },
    }).native?.parameter).toBe("reasoning.effort");
    expect(() => readModelReasoningCapability({
      schemaVersion: 1,
      control: "fixed",
      adjustable: true,
      supportedProfiles: ["balanced"],
      defaultProfile: "balanced",
    })).toThrow("adjustable");
    expect(() => readModelReasoningCapability({
      schemaVersion: 1,
      control: "fixed",
      adjustable: false,
      supportedProfiles: ["auto"],
      defaultProfile: "auto",
    })).toThrow("supportedProfiles");
    expect(() => readModelReasoningCapability({
      schemaVersion: 1,
      control: "effort_levels",
      adjustable: true,
      supportedProfiles: ["balanced", "balanced"],
      defaultProfile: "balanced",
    })).toThrow("adjustable");
  });

  it("用 toggle 精确表达布尔思考开关，而不是伪装成 effort 档位", () => {
    expect(readModelReasoningCapability({
      schemaVersion: 1,
      control: "toggle",
      adjustable: true,
      supportedProfiles: ["fast", "balanced"],
      defaultProfile: "balanced",
      native: { parameter: "think", values: [false, true] },
    })).toMatchObject({ control: "toggle", native: { values: [false, true] } });
    expect(() => readModelReasoningCapability({
      schemaVersion: 1,
      control: "toggle",
      adjustable: true,
      supportedProfiles: ["balanced", "deep"],
      defaultProfile: "balanced",
    })).toThrow("fast、balanced");
  });

  it("用共享函数确定缺失档位，距离相同时落到更低档", () => {
    expect(resolveSupportedReasoningProfile("balanced", ["fast", "deep"])).toBe("fast");
    expect(resolveSupportedReasoningProfile("max", ["fast", "deep"])).toBe("deep");
    expect(() => resolveSupportedReasoningProfile("balanced", [])).toThrow("至少需要一个");
  });
});
