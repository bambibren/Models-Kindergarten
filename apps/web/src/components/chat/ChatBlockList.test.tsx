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
    expect(html.match(/href=\"\/artifacts\/artifact_12345678\"/g)).toHaveLength(1);
    expect(html).toContain("<button type=\"button\">预览 页面</button>");
  });

  it("只在每个 Turn 的最后一个可见区块后插入一次外部操作", () => {
    const collection: EntryCollection = {
      order: ["message:u1", "message:a1", "message:u2", "message:a2"],
      byId: {
        "message:u1": { type: "message", id: "message:u1", messageId: "u1", turnId: "turn-1", role: "user", content: [{ type: "text", text: "问题一" }], status: "done" },
        "message:a1": { type: "message", id: "message:a1", messageId: "a1", turnId: "turn-1", role: "assistant", content: [{ type: "text", text: "回答一" }], status: "done" },
        "message:u2": { type: "message", id: "message:u2", messageId: "u2", turnId: "turn-2", role: "user", content: [{ type: "text", text: "问题二" }], status: "done" },
        "message:a2": { type: "message", id: "message:a2", messageId: "a2", turnId: "turn-2", role: "assistant", content: [{ type: "text", text: "回答二" }], status: "done" },
      },
    };
    const html = renderToStaticMarkup(<ChatBlockList collection={collection} renderTurnFooter={(turnId) => <a href={`/score/${turnId}`}>效果打分</a>} />);

    expect(html.match(/效果打分/g)).toHaveLength(2);
    expect(html.indexOf("回答一")).toBeLessThan(html.indexOf("/score/turn-1"));
    expect(html.indexOf("/score/turn-1")).toBeLessThan(html.indexOf("问题二"));
  });
});
