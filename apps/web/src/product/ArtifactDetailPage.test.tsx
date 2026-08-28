import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ArtifactDetailPage } from "./ArtifactDetailPage.js";

describe("ArtifactDetailPage", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("即使详情仍在加载，也提供固定返回产物列表入口", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const html = renderToStaticMarkup(<ArtifactDetailPage artifactId="artifact_12345678" />);

    expect(html).toContain("返回产物列表");
    expect(html).toContain('href="/me?tab=artifacts"');
  });
});
