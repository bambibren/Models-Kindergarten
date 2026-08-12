import { describe, expect, it } from "vitest";
import { isDemoRoute } from "./DemoApp.js";

describe("DemoApp routes", () => {
  it("does not expose the deferred model admission page", () => {
    expect(isDemoRoute("/demo/model-admission")).toBe(false);
    expect(isDemoRoute("/demo/model-admission/")).toBe(false);
    expect(isDemoRoute("/model-admission")).toBe(false);
  });
});
