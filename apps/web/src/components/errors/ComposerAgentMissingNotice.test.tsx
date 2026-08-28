import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ComposerAgentMissingNotice } from "./ComposerAvailabilityNotice.js";

describe("ComposerAgentMissingNotice", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("renders the deleted-Agent reason as an alert without a reconnect action", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const html = renderToStaticMarkup(<ComposerAgentMissingNotice />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("该会话绑定的 Agent 已删除，不能继续对话");
    expect(html).not.toContain("重新连接");
  });
});
