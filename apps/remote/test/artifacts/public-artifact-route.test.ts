import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PublicArtifactPreviewResponse } from "@kindergarten/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactBlobStore } from "../../src/artifacts/artifact-blob-store.js";
import { registerArtifactRoutes } from "../../src/artifacts/artifact-routes.js";
import { ArtifactRepository } from "../../src/artifacts/artifact-repository.js";
import { ArtifactService } from "../../src/artifacts/artifact-service.js";
import { ControlApi } from "../../src/server/control-api.js";
import { FileSandbox } from "../../src/tools/sandbox.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("public Artifact routes", () => {
  it("匿名读取 active 预览、Bundle 和下载，归档后统一返回 404", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mk-public-artifact-route-"));
    dirs.push(dir);
    const workspaces = join(dir, "workspaces");
    const sandbox = new FileSandbox(join(workspaces, "session-public"));
    await sandbox.initialize();
    await sandbox.writeText("site/index.html", "<script src=\"assets/app.js\"></script>");
    await sandbox.writeText("site/assets/app.js", "document.body.dataset.public = 'yes'");
    const service = new ArtifactService(
      new ArtifactRepository(join(dir, "artifacts.json")),
      new ArtifactBlobStore(join(dir, "blobs")),
      workspaces,
    );
    const artifact = await service.publishHtmlBundle({
      ownerId: "owner-a",
      sessionId: "session-public",
      turnId: "turn-public",
      operationId: "op-public",
      rootPath: "site",
      entryPath: "index.html",
      displayName: "公开页面",
    });
    let authenticationCalls = 0;
    const api = new ControlApi({
      allowedOrigins: [],
      resolvePrincipal: async () => {
        authenticationCalls += 1;
        return undefined;
      },
    });
    registerArtifactRoutes(api.router, service);
    const base = `http://localhost/api/control/v1/public/artifacts/${artifact.artifactId}`;

    const previewResponse = await api.fetch(new Request(`${base}/preview`));
    expect(previewResponse?.status).toBe(200);
    const previewEnvelope = await previewResponse?.json() as { data: PublicArtifactPreviewResponse };
    expect(previewEnvelope.data.artifact).toMatchObject({
      artifactId: artifact.artifactId,
      displayName: "公开页面",
      kind: "html_bundle",
    });
    expect(previewEnvelope.data.artifact).not.toHaveProperty("ownerId");
    expect(previewEnvelope.data.artifact).not.toHaveProperty("sourceSessionId");
    expect(previewEnvelope.data.content).toMatchObject({ kind: "static_html" });
    if (previewEnvelope.data.content.kind !== "static_html") throw new Error("预览类型错误");
    expect(previewEnvelope.data.content.html).toContain(`/public/artifacts/${artifact.artifactId}/bundle/`);

    const resource = await api.fetch(new Request(`${base}/bundle/assets/app.js`));
    expect(resource?.status).toBe(200);
    expect(await resource?.text()).toContain("dataset.public");
    const download = await api.fetch(new Request(`${base}/content`));
    expect(download?.status).toBe(200);
    expect(download?.headers.get("content-disposition")).toContain("attachment");
    expect(authenticationCalls).toBe(0);

    const internal = await api.fetch(new Request(
      `http://localhost/api/control/v1/artifacts/${artifact.artifactId}/preview`,
    ));
    expect(internal?.status).toBe(401);
    expect(authenticationCalls).toBe(1);

    await service.setState(artifact.artifactId, "owner-a", "archived");
    const archived = await api.fetch(new Request(`${base}/preview`));
    expect(archived?.status).toBe(404);
    expect(authenticationCalls).toBe(1);
  });
});
