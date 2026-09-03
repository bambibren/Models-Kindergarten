import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ContentRenderer, messageUrlTransform, rewriteInternalMarkdownLinks } from "./ContentRenderer.js";

describe("ContentRenderer internal links", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("把 Artifact Markdown 链接转换为可点击的安全 fragment", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const html = renderToStaticMarkup(<ContentRenderer content={[{
      type: "text",
      text: "[预览页面](artifact://artifact_12345678)",
    }]} />);

    expect(html).toContain("class=\"markdown-internal-link\"");
    expect(html).toContain("预览页面");
    expect(html).not.toContain("Blocked URL");
  });

  it("不放行无效内部 ID，也不改变普通 HTTPS 链接", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const node = { type: "element", tagName: "a", properties: {}, children: [] } as never;
    expect(messageUrlTransform("artifact://bad", "href", node)).not.toContain("mk-artifact");
    expect(messageUrlTransform("https://example.com", "href", node)).toBe("https://example.com");
    expect(rewriteInternalMarkdownLinks("artifact://bad")).toBe("artifact://bad");
  });

  it("不把 Workspace 文件引用渲染成可点击预览", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const html = renderToStaticMarkup(<ContentRenderer content={[{
      type: "resource_link",
      name: "draft.html",
      uri: "mk-file://file_12345678",
    }]} />);

    expect(html).toContain("draft.html");
    expect(html).not.toContain("href=");
    expect(messageUrlTransform("mk-file://file_12345678", "href", {} as never)).not.toContain("#mk-file=");
  });

  it("允许上下文实验把裸 Artifact 引用改为新页面链接", () => {
    const html = renderToStaticMarkup(<ContentRenderer
      artifactNavigation={{ href: (artifactId) => `/artifacts/${artifactId}` }}
      content={[{ type: "text", text: "产物：artifact://artifact_12345678" }]}
    />);

    expect(html).toContain("href=\"/artifacts/artifact_12345678\"");
    expect(html).toContain("target=\"_blank\"");
    expect(html).toContain("打开产物");
  });

  it("没有外部导航时把 Artifact 资源打开到本页预览", () => {
    const html = renderToStaticMarkup(<ContentRenderer content={[{
      type: "resource_link",
      name: "页面",
      uri: "artifact://artifact_12345678",
    }]} />);

    expect(html).toContain("<button type=\"button\">页面</button>");
    expect(html).not.toContain("target=\"_blank\"");
  });
});
