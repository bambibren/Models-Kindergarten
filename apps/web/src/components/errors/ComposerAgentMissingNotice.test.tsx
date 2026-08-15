import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ComposerAgentMissingNotice } from "./ComposerAvailabilityNotice.js";

describe("ComposerAgentMissingNotice", () => {
  it("renders the deleted-Agent reason as an alert without a reconnect action", () => {
    const html = renderToStaticMarkup(<ComposerAgentMissingNotice />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("该会话绑定的 Agent 已删除，不能继续对话");
    expect(html).not.toContain("重新连接");
  });
});
