import { describe, expect, it } from "vitest";
import { sessionSupportsEvaluationEntries } from "./evaluation-entry-compatibility.js";

describe("evaluation entry compatibility", () => {
  it("只为固定上线边界及之后创建的 Session 开放评测入口", () => {
    expect(sessionSupportsEvaluationEntries("2026-09-02T15:59:59.999Z")).toBe(false);
    expect(sessionSupportsEvaluationEntries("2026-09-02T16:00:00.000Z")).toBe(true);
    expect(sessionSupportsEvaluationEntries("invalid-created-at")).toBe(false);
  });
});
