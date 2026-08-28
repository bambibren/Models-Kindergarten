import { describe, expect, it } from "vitest";
import { demoExperiments } from "../demo-data.js";
import { filterExperiments, pageCount, pageExperiments } from "./me-data.js";

describe("my experiments list", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("filters against title, prompt and model", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    expect(filterExperiments(demoExperiments, "qwen3:8b")).toHaveLength(23);
    expect(filterExperiments(demoExperiments, "工具说明").every(/** 构造「toBe」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(item) => item.title.includes("工具说明"))).toBe(true);
  });

  it("returns ten records per page", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    expect(pageExperiments(demoExperiments, 1)).toHaveLength(10);
    expect(pageExperiments(demoExperiments, 3)).toHaveLength(3);
    expect(pageCount(demoExperiments.length)).toBe(3);
  });
});
