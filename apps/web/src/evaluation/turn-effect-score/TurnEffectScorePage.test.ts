import { describe, expect, it } from "vitest";
import type { SessionHistoryEntry } from "../../api/control-api.js";
import { promptRequirements, thoughtPlanningSteps } from "./TurnEffectScorePage.js";

describe("TurnEffectScorePage source projection", () => {
  it("只从用户 Prompt 的显式分行建立需求候选项", () => {
    expect(promptRequirements("- 复用真实组件\n- 综合页不要排名")).toEqual([
      { requirementId: "prompt-1", label: "复用真实组件" },
      { requirementId: "prompt-2", label: "综合页不要排名" },
    ]);
  });

  it("只把真实 thought 文本投影为只读规划材料", () => {
    const entries = [
      { type: "thought", text: "1. 读取现有实现\n2. 复用标注组件", turnId: "turn", messageId: "thought", createdAt: "now" },
      { type: "message", role: "assistant", text: "完成", turnId: "turn", messageId: "answer", createdAt: "now" },
    ] satisfies SessionHistoryEntry[];
    expect(thoughtPlanningSteps(entries).map((item) => item.label)).toEqual(["读取现有实现", "复用标注组件"]);
  });
});
