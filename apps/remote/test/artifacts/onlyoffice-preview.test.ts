import type { ArtifactRecord } from "@kindergarten/contracts";
import { describe, expect, it } from "vitest";
import { OnlyOfficePreviewService } from "../../src/artifacts/onlyoffice-preview.js";

describe("OnlyOfficePreviewService", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("为当前 PPTX 版本生成短时读取票据和可选 DocumentServer JWT", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const preview = new OnlyOfficePreviewService({
      documentServerPublicUrl: "http://127.0.0.1:8080/",
      artifactInternalBaseUrl: "http://host.docker.internal:7331/api/control/v1/",
      documentServerJwtSecret: "document-secret",
      ticketSigningSecret: "ticket-secret",
      ticketTtlSeconds: 300,
      now: /** 构造「now」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => 1_700_000_000_000,
    });

    const result = preview.create(pptxArtifact());
    const source = new URL(result.config.document.url);
    const token = source.searchParams.get("token");

    expect(result.documentServerApiUrl).toBe("http://127.0.0.1:8080/web-apps/apps/api/documents/api.js");
    expect(source.origin).toBe("http://host.docker.internal:7331");
    expect(source.pathname).toBe("/api/control/v1/onlyoffice/artifacts/artifact_pptx_preview/raw");
    expect(result.config).toMatchObject({
      type: "embedded",
      documentType: "slide",
      document: {
        fileType: "pptx",
        title: "演示文稿.pptx",
        permissions: { download: false, edit: false, print: false },
      },
      editorConfig: { mode: "view", embedded: { autostart: "player" } },
      token: expect.any(String),
    });
    expect(preview.verify("artifact_pptx_preview", token)).toMatchObject({
      artifactId: "artifact_pptx_preview",
      ownerId: "owner-a",
      sha256: "a".repeat(64),
      purpose: "onlyoffice-preview",
      exp: 1_700_000_300,
    });
  });

  it("拒绝过期、篡改和跨 Artifact 复用的票据", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    let now = 1_700_000_000_000;
    const preview = new OnlyOfficePreviewService({
      ticketSigningSecret: "ticket-secret",
      ticketTtlSeconds: 1,
      now: /** 构造「now」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => now,
    });
    const token = new URL(preview.create(pptxArtifact()).config.document.url).searchParams.get("token")!;

    expect(/** 构造「toThrow」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => preview.verify("artifact_another", token)).toThrow("无效或已过期");
    expect(/** 构造「toThrow」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => preview.verify("artifact_pptx_preview", `${token.slice(0, -1)}x`)).toThrow("无效或已过期");
    now += 2_000;
    expect(/** 构造「toThrow」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => preview.verify("artifact_pptx_preview", token)).toThrow("无效或已过期");
  });

  it("不为普通文件生成播放配置", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const preview = new OnlyOfficePreviewService({ ticketSigningSecret: "ticket-secret" });
    expect(/** 构造「toThrow」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => preview.create({
      ...pptxArtifact(),
      displayName: "note.txt",
      primary: { ...pptxArtifact().primary, mimeType: "text/plain" },
    })).toThrow("只有 PPTX Artifact");
  });
});

/** 构造「pptxArtifact」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function pptxArtifact(): ArtifactRecord {
  return {
    schemaVersion: 1,
    artifactId: "artifact_pptx_preview",
    ownerId: "owner-a",
    sourceSessionId: "session-a",
    sourceTurnId: "turn-a",
    kind: "file",
    displayName: "演示文稿",
    state: "active",
    primary: {
      sha256: "a".repeat(64),
      byteLength: 1024,
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    },
    operationId: "op-a",
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
  };
}
