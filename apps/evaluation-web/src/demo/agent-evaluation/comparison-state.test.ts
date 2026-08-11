import { describe, expect, it } from "vitest";
import { scrollTopForVisibleItem } from "./comparison-state.js";

describe("comparison list focus", () => {
  it("scrolls only when selected record is outside the viewport", () => {
    expect(scrollTopForVisibleItem(100, 300, 160, 48)).toBe(100);
    expect(scrollTopForVisibleItem(100, 300, 20, 48)).toBe(20);
    expect(scrollTopForVisibleItem(0, 300, 420, 48)).toBe(168);
  });
});
