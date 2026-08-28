import { describe, expect, it } from "vitest";
import { clampArtifactWidth, DEFAULT_CHAT_WIDTH, defaultArtifactWidth, SPLIT_PANE_DIVIDER, SPLIT_PANE_MIN } from "./split-pane.js";

describe("clampArtifactWidth", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("同时守住产物与聊天的 300px 下限", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    expect(clampArtifactWidth(150, 900)).toBe(300);
    expect(clampArtifactWidth(780, 900)).toBe(591);
    expect(clampArtifactWidth(460, 900)).toBe(460);
  });

  it("空间不足时返回单主视图的安全基线", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    expect(clampArtifactWidth(420, SPLIT_PANE_MIN * 2)).toBe(SPLIT_PANE_MIN);
    expect(clampArtifactWidth(420, 540)).toBe(SPLIT_PANE_MIN);
  });
});

describe("defaultArtifactWidth", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("首次打开产物时给聊天保留约 350px", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    expect(defaultArtifactWidth(1_000)).toBe(1_000 - DEFAULT_CHAT_WIDTH - SPLIT_PANE_DIVIDER);
    expect(defaultArtifactWidth(900)).toBe(541);
  });

  it("仍遵守两个面板的 300px 下限", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    expect(defaultArtifactWidth(640)).toBe(300);
  });
});
