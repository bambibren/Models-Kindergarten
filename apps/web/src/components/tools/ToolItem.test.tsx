import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ToolCallEntry } from "../../chat/chat-types.js";
import { ToolItem } from "./ToolItem.js";

describe("ToolItem", () => {
  it("在折叠详情外直接显示文件预览入口", () => {
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

    expect(html).toContain("预览 index.html");
    expect(html.indexOf("预览 index.html")).toBeLessThan(html.indexOf("tool-detail"));
  });
});
