import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildHtmlPreviewDocument, HtmlPreviewFrame } from "./HtmlPreviewFrame.js";

describe("HtmlPreviewFrame", () => {
  it("使用普通 srcDoc 预览，不增加 sandbox 限制", () => {
    const html = renderToStaticMarkup(<HtmlPreviewFrame
      csp="script-src 'unsafe-inline'"
      html="<script>document.body.dataset.executed = 'yes'</script>"
      title="交互预览"
    />);

    expect(html).not.toContain("sandbox=");
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).toContain("document.body.dataset.executed");
  });

  it("在页面脚本前接管当前文档锚点，避免 sandboxed srcDoc 导航为空白页", () => {
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
