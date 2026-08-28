import type { ArtifactPreviewResponse } from "@kindergarten/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PublishedPreview } from "./PublishedArtifactPanel.js";
import { shouldUseStaticPptxPreview } from "../components/artifacts/PptxPreview.js";

describe("PublishedPreview", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("浏览器 PPTX 静态预览严格限制为 32 MiB", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    expect(shouldUseStaticPptxPreview(32 * 1024 * 1024)).toBe(true);
    expect(shouldUseStaticPptxPreview(32 * 1024 * 1024 + 1)).toBe(false);
  });
  it("PPTX Artifact 进入浏览器预览组件而不是仅下载兜底", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const value: ArtifactPreviewResponse = {
      artifact: {
        schemaVersion: 1,
        artifactId: "artifact_pptx_preview",
        ownerId: "local-admin",
        sourceSessionId: "session-pptx",
        sourceTurnId: "turn-pptx",
        kind: "file",
        displayName: "deck.pptx",
        state: "active",
        primary: {
          sha256: "a".repeat(64),
          byteLength: 1024,
          mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        },
        operationId: "op-pptx",
        createdAt: "2026-08-18T00:00:00.000Z",
        updatedAt: "2026-08-18T00:00:00.000Z",
      },
      content: { kind: "pptx", contentUrl: "/api/control/v1/artifacts/artifact_pptx_preview/raw" },
    };

    const html = renderToStaticMarkup(<PublishedPreview value={value} />);

    expect(html).toContain("deck.pptx PPTX 预览");
    expect(html).toContain("正在解析 PPTX");
    expect(html).toContain("动画播放");
    expect(html).not.toContain("该格式仅支持下载");
  });
});
