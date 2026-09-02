import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EntryCollection } from "../../chat/chat-types.js";
import { ChatBlockList } from "./ChatBlockList.js";

describe("ChatBlockList", () => {
  it("同一消息流组件同时渲染思考、工具、回答和外部产物导航", () => {
    const collection: EntryCollection = {
      order: ["thought:1", "tool:1", "message:1"],
      byId: {
        "thought:1": { type: "thought", id: "thought:1", messageId: "1", turnId: "turn-1", content: [{ type: "text", text: "准备发布" }], status: "done" },
        "tool:1": {
          type: "tool_call", id: "tool:1", toolCallId: "1", turnId: "turn-1", title: "发布页面", name: "publish_artifact", kind: "other", status: "completed", locations: [],
          content: [{ type: "content", content: { type: "resource_link", name: "页面", uri: "artifact://artifact_12345678" } }],
        },
        "message:1": { type: "message", id: "message:1", messageId: "1", turnId: "turn-1", role: "assistant", content: [{ type: "text", text: "[打开页面](artifact://artifact_12345678)" }], status: "done" },
      },
    };

    const html = renderToStaticMarkup(<ChatBlockList
      artifactNavigation={{ href: (artifactId) => `/artifacts/${artifactId}` }}
      collection={collection}
    />);

    expect(html).toContain("activity-group");
    expect(html).toContain("reasoning-item");
    expect(html).toContain("tool-item");
    expect(html).toContain("assistant-message");
    expect(html.match(/href=\"\/artifacts\/artifact_12345678\"/g)).toHaveLength(2);
  });
});
