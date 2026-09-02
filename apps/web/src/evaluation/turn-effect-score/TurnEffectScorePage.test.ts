import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SessionHistoryEntry } from "../../api/control-api.js";
import { promptRequirements, thoughtPlanningSteps, turnTotalScore, TurnScoreSummary, TurnUnderstandingPanel } from "./TurnEffectScorePage.js";

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

  it("理解 Tab 保留真实需求列表，但不重复增加逐条判断小模块", () => {
    const html = renderToStaticMarkup(TurnUnderstandingPanel({
      hasOtherRequirement: false,
      listedRequirementsWeight: 80,
      requirements: [{ requirementId: "prompt-1", label: "复用真实组件" }],
      selectedRequirementIds: ["prompt-1"],
      onOtherRequirementToggle: () => undefined,
      onToggle: () => undefined,
      onWeightChange: () => undefined,
    }));

    expect(html).toContain("需求理解能力 打分");
    expect(html).toContain("请选出您真正的需求");
    expect(html).not.toContain("当前理解得分");
    expect(html).not.toContain("所选 Turn 理解判断");
    expect(html).not.toContain("已理解");
    expect(html).not.toContain("未理解");
    expect(html).not.toContain("turn-understanding-map");
  });

  it("综合能力分布按四维等权计算并展示总分", () => {
    const scores = { understanding: 81, planning: 72, output: 90, execution: 65 };
    const html = renderToStaticMarkup(TurnScoreSummary({ scores }));

    expect(turnTotalScore(scores)).toBe(77);
    expect(html).not.toContain("综合总分");
    expect(html).toContain('<div class="turn-total-score"><span>总分</span><strong>77</strong><small>/ 100</small></div>');
    expect(html).toContain("理解、规划、输出、执行各占 25%");
  });
});
