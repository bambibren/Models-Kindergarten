import { describe, expect, it } from "vitest";
import { isDemoRoute } from "./DemoApp.js";

describe("DemoApp routes", () => {
  it("keeps model admission inside the isolated Demo application", () => {
    expect(isDemoRoute("/demo/model-admission")).toBe(true);
    expect(isDemoRoute("/demo/model-admission/")).toBe(true);
    expect(isDemoRoute("/model-admission")).toBe(false);
  });
});
