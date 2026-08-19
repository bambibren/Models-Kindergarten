import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ContextWindowUsageIndicator } from "./ContextWindowUsageIndicator.js";

describe("ContextWindowUsageIndicator", () => {
  it("把真实占用和预警等级投影成输入框旁的可访问圆环", () => {
    const html = renderToStaticMarkup(<ContextWindowUsageIndicator value={{
      afterTurnId: "turn-1",
      estimatedTokens: 80_000,
      windowTokens: 100_000,
      remainingTokens: 20_000,
      percent: 80,
      ringPercent: 80,
      level: "critical",
    }} />);
    expect(html).toContain("上下文窗口已使用 80.0%");
    expect(html).toContain("context-window-trigger critical");
    expect(html).toContain('stroke-dasharray="80 100"');
  });
});
