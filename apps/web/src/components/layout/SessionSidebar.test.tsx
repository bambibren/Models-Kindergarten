import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionSidebar } from "./SessionSidebar.js";

describe("SessionSidebar", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("does not claim every session uses the built-in qwen model", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const html = renderToStaticMarkup(<SessionSidebar
      activeId={null}
      disabled={false}
      onCreate={/** 构造「onCreate」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => undefined}
      onSelect={/** 构造「onSelect」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => undefined}
      sessions={[]}
    />);

    expect(html).not.toContain("qwen3:8b");
    expect(html).not.toContain("Ollama · 本地运行");
  });
});
