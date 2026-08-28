import { describe, expect, it } from "vitest";
import {
  parseReasoningProfile,
  readModelReasoningCapability,
  resolveSupportedReasoningProfile,
} from "./reasoning.js";

describe("reasoning contracts", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("只接受稳定的产品级推理档位", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    expect(parseReasoningProfile("deep")).toBe("deep");
    expect(/** 构造「toThrow」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => parseReasoningProfile("xhigh")).toThrow("auto、fast、balanced、deep 或 max");
  });

  it("拒绝能力默认值、可调标记和档位集合互相矛盾", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    expect(readModelReasoningCapability({
      schemaVersion: 1,
      control: "effort_levels",
      adjustable: true,
      supportedProfiles: ["fast", "balanced", "deep", "max"],
      defaultProfile: "balanced",
      native: { parameter: "reasoning.effort", values: ["low", "medium", "high", "xhigh"] },
    }).native?.parameter).toBe("reasoning.effort");
    expect(/** 构造「toThrow」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => readModelReasoningCapability({
      schemaVersion: 1,
      control: "fixed",
      adjustable: true,
      supportedProfiles: ["balanced"],
      defaultProfile: "balanced",
    })).toThrow("adjustable");
    expect(/** 构造「toThrow」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => readModelReasoningCapability({
      schemaVersion: 1,
      control: "fixed",
      adjustable: false,
      supportedProfiles: ["auto"],
      defaultProfile: "auto",
    })).toThrow("supportedProfiles");
    expect(/** 构造「toThrow」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => readModelReasoningCapability({
      schemaVersion: 1,
      control: "effort_levels",
      adjustable: true,
      supportedProfiles: ["balanced", "balanced"],
      defaultProfile: "balanced",
    })).toThrow("adjustable");
  });

  it("用 toggle 精确表达布尔思考开关，而不是伪装成 effort 档位", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    expect(readModelReasoningCapability({
      schemaVersion: 1,
      control: "toggle",
      adjustable: true,
      supportedProfiles: ["fast", "balanced"],
      defaultProfile: "balanced",
      native: { parameter: "think", values: [false, true] },
    })).toMatchObject({ control: "toggle", native: { values: [false, true] } });
    expect(/** 构造「toThrow」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => readModelReasoningCapability({
      schemaVersion: 1,
      control: "toggle",
      adjustable: true,
      supportedProfiles: ["balanced", "deep"],
      defaultProfile: "balanced",
    })).toThrow("fast、balanced");
  });

  it("用共享函数确定缺失档位，距离相同时落到更低档", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    expect(resolveSupportedReasoningProfile("balanced", ["fast", "deep"])).toBe("fast");
    expect(resolveSupportedReasoningProfile("max", ["fast", "deep"])).toBe("deep");
    expect(/** 构造「toThrow」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => resolveSupportedReasoningProfile("balanced", [])).toThrow("至少需要一个");
  });
});
