import { describe, expect, it } from "vitest";
import { scrollTopForVisibleItem } from "./comparison-state.js";

describe("comparison list focus", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("scrolls only when selected record is outside the viewport", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    expect(scrollTopForVisibleItem(100, 300, 160, 48)).toBe(100);
    expect(scrollTopForVisibleItem(100, 300, 20, 48)).toBe(20);
    expect(scrollTopForVisibleItem(0, 300, 420, 48)).toBe(168);
  });
});
