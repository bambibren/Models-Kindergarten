import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PublicArtifactPage } from "./PublicArtifactPage.js";

describe("PublicArtifactPage", () => {
  it("匿名页面在加载阶段不挂载账号导航或管理动作", () => {
    const html = renderToStaticMarkup(<PublicArtifactPage artifactId="artifact_public123" />);

    expect(html).toContain("公开 Artifact");
    expect(html).toContain("正在读取 Artifact");
    expect(html).not.toContain("退出登录");
    expect(html).not.toContain("归档");
    expect(html).not.toContain("恢复");
  });
});
