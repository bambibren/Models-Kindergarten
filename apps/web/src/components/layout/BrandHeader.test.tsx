import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionSidebar } from "./SessionSidebar.js";
import { ProductNav } from "../../product/ProductNav.js";

describe("brand headers", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("uses the requested Chinese title and English subtitle on the session header", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const html = renderToStaticMarkup(<SessionSidebar sessions={[]} activeId={null} disabled={false} onCreate={/** 构造「onCreate」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => undefined} onSelect={/** 构造「onSelect」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => undefined} />);
    expect(html).toContain("模型幼儿园");
    expect(html).toContain("Models KinderGarten");
    expect(html).toContain('href="/"');
    expect(html).not.toContain("Local ACP classroom");
  });

  it("uses the requested Chinese title and English subtitle on the home header", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const html = renderToStaticMarkup(<ProductNav active="home" />);
    expect(html).toContain("模型幼儿园");
    expect(html).toContain("Models KinderGarten");
    expect(html).toContain('href="/"');
    expect(html).not.toContain("ModelStudent</strong>");
  });
});
