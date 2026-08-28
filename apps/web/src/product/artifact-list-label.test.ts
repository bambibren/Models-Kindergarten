import { describe, expect, it } from "vitest";
import { artifactListLabel } from "./artifact-list-label.js";

describe("artifactListLabel", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("用会话短名和文件名共同区分常见 index 文件", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    expect(artifactListLabel(
      "index.html",
      "69024308-bf35-401b-8e13-5d3c070272e0",
      "为新品发布会生成一个带复杂动效的 HTML 页面",
      2,
    )).toEqual({
      title: "为新品发布会生成一个带复杂动效的… · index.html · v2",
      fullTitle: "为新品发布会生成一个带复杂动效的 HTML 页面 · index.html · v2",
      sessionRef: "会话 #0272e0",
    });
  });

  it("会话名称缺失时仍提供稳定可识别尾号", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    expect(artifactListLabel("report.pdf", "session-abcdef")).toMatchObject({
      title: "未命名会话 · report.pdf · v1",
      sessionRef: "会话 #abcdef",
    });
  });
});
