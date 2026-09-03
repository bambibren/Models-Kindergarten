import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ToolCallEntry } from "../../chat/chat-types.js";
import { ToolItem } from "./ToolItem.js";

describe("ToolItem", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("区分工具准备与真实执行状态", () => {
    const pending = renderToStaticMarkup(<ToolItem entry={toolEntry("pending")} />);
    const running = renderToStaticMarkup(<ToolItem entry={toolEntry("in_progress")} />);

    expect(pending).toContain("准备中");
    expect(pending).not.toContain("执行中");
    expect(running).toContain("执行中");
  });

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

  it("外层消息流的新页面导航不改变工具卡片的本页预览入口", () => {
    const entry: ToolCallEntry = {
      id: "tool:publish-2",
      type: "tool_call",
      turnId: "turn-1",
      toolCallId: "publish-2",
      title: "发布页面",
      name: "publish_artifact",
      kind: "other",
      status: "completed",
      content: [{
        type: "content",
        content: {
          type: "resource_link",
          name: "页面",
          uri: "artifact://artifact_12345678",
        },
      }],
      locations: [],
    };

    const html = renderToStaticMarkup(<ToolItem entry={entry} />);

    expect(html).toContain("<button type=\"button\">预览 页面</button>");
    expect(html).not.toContain("target=\"_blank\"");
    expect(html).not.toContain("href=\"/artifacts/artifact_12345678\"");
  });
});

function toolEntry(status: ToolCallEntry["status"]): ToolCallEntry {
  return {
    id: "tool:status",
    type: "tool_call",
    turnId: "turn-status",
    toolCallId: "status",
    title: "写入 index.html",
    name: "write_file",
    kind: "edit",
    status,
    content: [],
    locations: [],
  };
}
