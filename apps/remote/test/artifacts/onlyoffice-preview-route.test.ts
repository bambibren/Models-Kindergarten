import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PptxPlaybackResponse } from "@kindergarten/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactBlobStore } from "../../src/artifacts/artifact-blob-store.js";
import { registerArtifactRoutes } from "../../src/artifacts/artifact-routes.js";
import { ArtifactRepository } from "../../src/artifacts/artifact-repository.js";
import { ArtifactService } from "../../src/artifacts/artifact-service.js";
import { OnlyOfficePreviewService } from "../../src/artifacts/onlyoffice-preview.js";
import { ControlApi } from "../../src/server/control-api.js";
import { FileSandbox } from "../../src/tools/sandbox.js";

const dirs: string[] = [];
afterEach(/** 在每个测试后释放临时资源，保证后续场景从干净状态开始。 */
async () => Promise.all(dirs.splice(0).map(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(dir) => rm(dir, { recursive: true, force: true }))));

describe("ONLYOFFICE Artifact routes", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("只向 owner 签发播放配置，并允许 DocumentServer 用短时票据读取当前版本", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const dir = await mkdtemp(join(tmpdir(), "mk-onlyoffice-route-"));
    dirs.push(dir);
    const workspaces = join(dir, "workspaces");
    const sandbox = new FileSandbox(join(workspaces, "session-pptx"));
    await sandbox.initialize();
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
    await sandbox.writeBytes("deck.pptx", bytes);
    const service = new ArtifactService(
      new ArtifactRepository(join(dir, "artifacts.json")),
      new ArtifactBlobStore(join(dir, "blobs")),
      workspaces,
    );
    const artifact = await service.publishFile({
      ownerId: "local-admin",
      sessionId: "session-pptx",
      turnId: "turn-pptx",
      operationId: "op-pptx",
      path: "deck.pptx",
    });
    const api = new ControlApi({ allowedOrigins: [] });
    registerArtifactRoutes(api.router, service, new OnlyOfficePreviewService({
      artifactInternalBaseUrl: "http://host.docker.internal:7331/api/control/v1",
      ticketSigningSecret: "route-test-secret",
      now: /** 构造「now」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => 1_700_000_000_000,
    }));

    const playbackResponse = await api.fetch(new Request(
      `http://127.0.0.1:7331/api/control/v1/artifacts/${artifact.artifactId}/pptx-playback`,
    ));
    expect(playbackResponse?.status).toBe(200);
    const playbackEnvelope = await playbackResponse?.json() as { data: PptxPlaybackResponse };
    const rawResponse = await api.fetch(new Request(playbackEnvelope.data.config.document.url));

    expect(rawResponse?.status).toBe(200);
    expect(rawResponse?.headers.get("cache-control")).toBe("private, no-store");
    expect(rawResponse?.headers.get("content-disposition")).toContain("inline");
    expect(new Uint8Array(await rawResponse!.arrayBuffer())).toEqual(bytes);

    const tampered = new URL(playbackEnvelope.data.config.document.url);
    tampered.searchParams.set("token", `${tampered.searchParams.get("token")}x`);
    const rejected = await api.fetch(new Request(tampered));
    expect(rejected?.status).toBe(404);
  });
});
