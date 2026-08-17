import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatHeader } from "./ChatHeader.js";

describe("ChatHeader", () => {
  it("shows the bound ModelStudent context window", () => {
    const html = renderToStaticMarkup(<ChatHeader
      connection={{ phase: "connected" }}
      identity={{
        agentName: "系统默认 Agent",
        modelName: "Kimi2.7",
        contextWindowTokens: 262_144,
      }}
    />);

    expect(html).toContain("Kimi2.7");
    expect(html).toContain("上下文窗口 262,144 tokens");
  });

  it("omits context copy and its separator when no value exists", () => {
    const html = renderToStaticMarkup(<ChatHeader
      connection={{ phase: "connected" }}
      identity={{ agentName: "Agent", modelName: "未知模型" }}
    />);

    expect(html).not.toContain("上下文窗口");
    expect(html).toContain("<small>未知模型</small></div>");
  });
});
