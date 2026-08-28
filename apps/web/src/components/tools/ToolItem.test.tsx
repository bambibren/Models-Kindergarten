import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ToolCallEntry } from "../../chat/chat-types.js";
import { ToolItem } from "./ToolItem.js";

describe("ToolItem", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("不为 Workspace 文件引用显示预览入口", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const entry: ToolCallEntry = {
      id: "tool:write-1",
      type: "tool_call",
      turnId: "turn-1",
      toolCallId: "write-1",
      title: "写入 index.html",
      name: "write_file",
      kind: "edit",
      status: "completed",
      rawInput: { path: "index.html" },
      rawOutput: { path: "/workspace/index.html" },
      content: [{
        type: "content",
        content: {
          type: "resource_link",
          name: "index.html",
          title: "index.html",
          uri: "mk-file://file_1234567890abcdef1234567890abcdef",
        },
      }],
      locations: [],
    };

    const html = renderToStaticMarkup(<ToolItem entry={entry} />);

    expect(html).not.toContain("预览 index.html");
  });

  it("只为已发布 Artifact 显示预览入口", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const entry: ToolCallEntry = {
      id: "tool:publish-1",
      type: "tool_call",
      turnId: "turn-1",
      toolCallId: "publish-1",
      title: "发布 index.html",
      name: "publish_artifact",
      kind: "other",
      status: "completed",
      content: [{
        type: "content",
        content: {
          type: "resource_link",
          name: "index.html",
          title: "index.html",
          uri: "artifact://artifact_12345678",
        },
      }],
      locations: [],
    };

    const html = renderToStaticMarkup(<ToolItem entry={entry} />);

    expect(html).toContain("预览 index.html");
    expect(html.indexOf("预览 index.html")).toBeLessThan(html.indexOf("tool-detail"));
  });
});
