import { describe, expect, it } from "vitest";
import { isDemoRoute } from "./DemoApp.js";

describe("DemoApp routes", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("does not expose the deferred model admission page", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    expect(isDemoRoute("/demo/model-admission")).toBe(false);
    expect(isDemoRoute("/demo/model-admission/")).toBe(false);
    expect(isDemoRoute("/model-admission")).toBe(false);
  });
});
