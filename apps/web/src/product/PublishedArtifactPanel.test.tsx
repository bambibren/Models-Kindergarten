import type { ArtifactPreviewResponse } from "@kindergarten/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PublishedPreview } from "./PublishedArtifactPanel.js";

describe("PublishedPreview", () => {
  it("PPTX Artifact 进入浏览器预览组件而不是仅下载兜底", () => {
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
