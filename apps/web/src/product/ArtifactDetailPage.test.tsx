import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ArtifactDetailPage } from "./ArtifactDetailPage.js";

describe("ArtifactDetailPage", () => {
  it("即使详情仍在加载，也提供固定返回产物列表入口", () => {
    const html = renderToStaticMarkup(<ArtifactDetailPage artifactId="artifact_12345678" />);

    expect(html).toContain("返回产物列表");
    expect(html).toContain('href="/me?tab=artifacts"');
  });
});
