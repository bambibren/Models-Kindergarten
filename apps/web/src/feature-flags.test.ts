import { describe, expect, it } from "vitest";
import { contextExperimentsEnabled } from "./feature-flags.js";

describe("context experiments feature flag", () => {
  it("默认关闭，只接受显式 true", () => {
    expect(contextExperimentsEnabled({})).toBe(false);
    expect(contextExperimentsEnabled({ VITE_ENABLE_CONTEXT_EXPERIMENTS: "false" })).toBe(false);
    expect(contextExperimentsEnabled({ VITE_ENABLE_CONTEXT_EXPERIMENTS: "true" })).toBe(true);
  });
});
