import { describe, expect, it } from "vitest";
import { formatContextWindow, joinMetadata } from "./token-format.js";

describe("context window formatting", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it.each([
    [1_050_000, "上下文窗口 1,050,000 tokens"],
    [1_048_576, "上下文窗口 1,048,576 tokens"],
    [262_144, "上下文窗口 262,144 tokens"],
    [197_000, "上下文窗口 197,000 tokens"],
    [32_768, "上下文窗口 32,768 tokens"],
    [65_535, "上下文窗口 65,535 tokens"],
  ])("formats %i as the exact configured number", /** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(value, expected) => {
    expect(formatContextWindow(value)).toBe(expected);
  });

  it.each([undefined, 0, -1, 1.5, Number.NaN])("omits an absent or invalid value", /** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(value) => {
    expect(formatContextWindow(value)).toBeUndefined();
  });

  it("joins model metadata without leaving a separator for an omitted context window", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    expect(joinMetadata([formatContextWindow(undefined), "provider-model-id", "可用"]))
      .toBe("provider-model-id · 可用");
  });
});
