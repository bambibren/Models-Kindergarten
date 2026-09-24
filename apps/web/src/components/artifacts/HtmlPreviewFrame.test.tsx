import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildHtmlPreviewDocument, HtmlPreviewFrame } from "./HtmlPreviewFrame.js";

describe("HtmlPreviewFrame", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("允许交互脚本和下载，但不允许产物继承应用同源权限", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const html = renderToStaticMarkup(<HtmlPreviewFrame
      csp="script-src 'unsafe-inline'"
      html="<script>document.body.dataset.executed = 'yes'</script>"
      title="交互预览"
    />);

    expect(html).toContain('sandbox="allow-downloads allow-scripts"');
    expect(html).not.toContain("allow-same-origin");
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).toContain("document.body.dataset.executed");
  });

  it("在页面脚本前接管当前文档锚点，避免 sandboxed srcDoc 导航为空白页", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const document = buildHtmlPreviewDocument(
      "<!doctype html><html><head><script>window.pageScript = true</script></head><body><a href=\"#game\">小游戏</a><section id=\"game\"></section></body></html>",
      "script-src 'unsafe-inline'",
    );

    expect(document).toContain("data-models-kindergarten-preview-navigation");
    expect(document).toContain('source.closest("a[href]")');
    expect(document).toContain("event.preventDefault()");
    expect(document).toContain("event.stopPropagation()");
    expect(document).toContain("event.stopImmediatePropagation()");
    expect(document).toContain("window.scrollTo({ top, behavior })");
    expect(document).not.toContain('for (const method of ["pushState", "replaceState"])');
    expect(document).not.toContain("scrollIntoView");
    expect(document.indexOf("Content-Security-Policy")).toBeLessThan(document.indexOf("data-models-kindergarten-preview-navigation"));
    expect(document.indexOf("data-models-kindergarten-preview-navigation")).toBeLessThan(document.indexOf("window.pageScript"));
  });
});
