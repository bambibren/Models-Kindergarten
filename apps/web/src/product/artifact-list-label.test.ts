import { describe, expect, it } from "vitest";
import { artifactListLabel } from "./artifact-list-label.js";

describe("artifactListLabel", () => {
  it("用会话短名和文件名共同区分常见 index 文件", () => {
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

  it("会话名称缺失时仍提供稳定可识别尾号", () => {
    expect(artifactListLabel("report.pdf", "session-abcdef")).toMatchObject({
      title: "未命名会话 · report.pdf · v1",
      sessionRef: "会话 #abcdef",
    });
  });
});
