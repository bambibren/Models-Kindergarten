import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ContentRenderer, messageUrlTransform, rewriteInternalMarkdownLinks } from "./ContentRenderer.js";

describe("ContentRenderer internal links", () => {
  it("把 Artifact Markdown 链接转换为可点击的安全 fragment", () => {
    const html = renderToStaticMarkup(<ContentRenderer content={[{
      type: "text",
      text: "[预览页面](artifact://artifact_12345678)",
    }]} />);

    expect(html).toContain("class=\"markdown-internal-link\"");
    expect(html).toContain("预览页面");
    expect(html).not.toContain("Blocked URL");
  });

  it("不放行无效内部 ID，也不改变普通 HTTPS 链接", () => {
    const node = { type: "element", tagName: "a", properties: {}, children: [] } as never;
    expect(messageUrlTransform("artifact://bad", "href", node)).not.toContain("mk-artifact");
    expect(messageUrlTransform("https://example.com", "href", node)).toBe("https://example.com");
    expect(rewriteInternalMarkdownLinks("artifact://bad")).toBe("artifact://bad");
  });

  it("不把 Workspace 文件引用渲染成可点击预览", () => {
    const html = renderToStaticMarkup(<ContentRenderer content={[{
      type: "resource_link",
      name: "draft.html",
      uri: "mk-file://file_12345678",
    }]} />);

    expect(html).toContain("draft.html");
    expect(html).not.toContain("href=");
    expect(messageUrlTransform("mk-file://file_12345678", "href", {} as never)).not.toContain("#mk-file=");
  });
});
