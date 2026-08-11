import { describe, expect, it } from "vitest";
import { demoExperiments } from "../demo-data.js";
import { filterExperiments, pageCount, pageExperiments } from "./me-data.js";

describe("my experiments list", () => {
  it("filters against title, prompt and model", () => {
    expect(filterExperiments(demoExperiments, "qwen3:8b")).toHaveLength(23);
    expect(filterExperiments(demoExperiments, "工具说明").every((item) => item.title.includes("工具说明"))).toBe(true);
  });

  it("returns ten records per page", () => {
    expect(pageExperiments(demoExperiments, 1)).toHaveLength(10);
    expect(pageExperiments(demoExperiments, 3)).toHaveLength(3);
    expect(pageCount(demoExperiments.length)).toBe(3);
  });
});
