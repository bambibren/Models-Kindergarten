import { mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactBlobStore } from "../../src/artifacts/artifact-blob-store.js";
import { ArtifactRepository } from "../../src/artifacts/artifact-repository.js";
import { ArtifactService } from "../../src/artifacts/artifact-service.js";
import { FileSandbox } from "../../src/tools/sandbox.js";

const dirs: string[] = [];
afterEach(/** 在每个测试后释放临时资源，保证后续场景从干净状态开始。 */
async () => Promise.all(dirs.splice(0).map(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(dir) => rm(dir, { recursive: true, force: true }))));

describe("ArtifactService", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("按内容哈希复用 Blob，并按 operationId 幂等发布", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const fixture = await setup();
    const sandbox = await workspace(fixture.workspaces, "session-a");
    await sandbox.writeText("first.txt", "same bytes");
    await sandbox.writeText("second.txt", "same bytes");

    const first = await fixture.service.publishFile(input("session-a", "turn-a", "op-a", "first.txt"));
    const sameOperation = await fixture.service.publishFile(input("session-a", "turn-a", "op-a", "second.txt"));
    const second = await fixture.service.publishFile(input("session-a", "turn-a", "op-b", "second.txt"));

    expect(sameOperation.artifactId).toBe(first.artifactId);
    expect(second.artifactId).not.toBe(first.artifactId);
    expect(second.primary.sha256).toBe(first.primary.sha256);
    expect(await readdir(fixture.blobsRoot)).toEqual([first.primary.sha256]);
  });

  it("覆盖保持 Artifact ID 和 vN，创建新版本由服务端自增", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const fixture = await setup();
    const sandbox = await workspace(fixture.workspaces, "session-version");
    await sandbox.writeText("page.html", "v1 first");
    const v1 = await fixture.service.publishFile(input("session-version", "turn-1", "op-1", "page.html"));

    await sandbox.writeText("page.html", "v1 updated");
    const replaced = await fixture.service.replaceFile(
      v1.artifactId,
      input("session-version", "turn-2", "op-2", "page.html"),
    );
    const sameOperation = await fixture.service.replaceFile(
      v1.artifactId,
      input("session-version", "turn-2", "op-2", "page.html"),
    );
    const v2 = await fixture.service.publishFileVersion(
      v1.artifactId,
      input("session-version", "turn-3", "op-3", "page.html"),
    );
    const v3 = await fixture.service.publishFileVersion(
      v2.artifactId,
      input("session-version", "turn-4", "op-4", "page.html"),
    );

    expect(replaced.artifactId).toBe(v1.artifactId);
    expect(sameOperation.artifactId).toBe(v1.artifactId);
    expect(replaced.version).toBe(1);
    expect(replaced.revisions).toHaveLength(2);
    expect([v1.version, v2.version, v3.version]).toEqual([1, 2, 3]);
    expect(new Set([v1.artifactId, v2.artifactId, v3.artifactId]).size).toBe(3);
    expect(v2.seriesId).toBe(v1.artifactId);
    expect(v3.seriesId).toBe(v1.artifactId);
  });

  it("拒绝跨 Session 覆盖同一 ID，但允许创建服务端新版本", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const fixture = await setup();
    const source = await workspace(fixture.workspaces, "session-source");
    await source.writeText("page.html", "source");
    const v1 = await fixture.service.publishFile(input("session-source", "turn-1", "op-1", "page.html"));
    const target = await workspace(fixture.workspaces, "session-target");
    await target.writeText("page.html", "target");

    await expect(fixture.service.replaceFile(
      v1.artifactId,
      input("session-target", "turn-2", "op-2", "page.html"),
    )).rejects.toThrow("跨 Session 修改必须使用 publish_artifact_version");

    const v2 = await fixture.service.publishFileVersion(
      v1.artifactId,
      input("session-target", "turn-3", "op-3", "page.html"),
    );
    expect(v2).toMatchObject({ version: 2, sourceSessionId: "session-target" });
    expect(v2.artifactId).not.toBe(v1.artifactId);
  });

  it("每个 Artifact ID 只保留包含当前内容在内的最近三份修订，并可按步数回滚", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const fixture = await setup();
    const sandbox = await workspace(fixture.workspaces, "session-rollback");
    await sandbox.writeText("note.txt", "one");
    const artifact = await fixture.service.publishFile(input("session-rollback", "turn-1", "op-1", "note.txt"));
    for (const [index, text] of ["two", "three", "four"].entries()) {
      await sandbox.writeText("note.txt", text);
      await fixture.service.replaceFile(
        artifact.artifactId,
        input("session-rollback", `turn-${index + 2}`, `op-${index + 2}`, "note.txt"),
      );
    }

    const current = await fixture.service.get(artifact.artifactId, "local-admin");
    expect(current.revisions).toHaveLength(3);
    expect((await fixture.service.content(artifact.artifactId, "local-admin")).bytes.toString()).toBe("four");

    const rolledBack = await fixture.service.rollback({
      artifactId: artifact.artifactId,
      ownerId: "local-admin",
      sessionId: "session-rollback",
      turnId: "turn-rollback",
      operationId: "op-rollback",
      steps: 2,
    });
    expect(rolledBack.artifactId).toBe(artifact.artifactId);
    expect(rolledBack.version).toBe(1);
    expect(rolledBack.revisions).toHaveLength(3);
    expect((await fixture.service.content(artifact.artifactId, "local-admin")).bytes.toString()).toBe("two");
    expect(await readdir(fixture.blobsRoot)).toHaveLength(3);
  });

  it("禁止跨 owner 读取，并且发布源只能来自当前 Session Workspace", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const fixture = await setup();
    const source = await workspace(fixture.workspaces, "session-a");
    await source.writeText("private.txt", "private");
    const artifact = await fixture.service.publishFile(input("session-a", "turn-a", "op-a", "private.txt"));

    await expect(fixture.service.get(artifact.artifactId, "another-owner"))
      .rejects.toMatchObject({ code: "ARTIFACT_FORBIDDEN" });
    await expect(fixture.service.publishFile(input("session-b", "turn-b", "op-b", "private.txt")))
      .rejects.toThrow();
  });

  it("HTML Bundle 保留 JavaScript，并通过 base 地址解析相对资源", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const fixture = await setup();
    const sandbox = await workspace(fixture.workspaces, "session-html");
    await sandbox.writeText("site/index.html", "<!doctype html><html><head></head><body><script src=\"assets/app.js\"></script></body></html>");
    await sandbox.writeText("site/assets/app.js", "document.body.dataset.ready = 'yes'");
    await sandbox.writeText("site/assets/theme.css", "body { color: rebeccapurple }");

    const artifact = await fixture.service.publishHtmlBundle({
      ownerId: "local-admin", sessionId: "session-html", turnId: "turn-html", operationId: "op-html",
      rootPath: "site", entryPath: "index.html", displayName: "互动页面",
    });
    const preview = await fixture.service.preview(artifact.artifactId, "local-admin", "https://preview.example.test/api/control/v1");

    expect(artifact.manifest?.files).toHaveProperty("assets/app.js");
    expect(preview.content).toMatchObject({ kind: "static_html" });
    if (preview.content.kind !== "static_html") throw new Error("预览类型错误");
    expect(preview.content.html).toContain('<base href="https://preview.example.test/api/control/v1/artifacts/');
    expect(preview.content.html).toContain('<script src="assets/app.js"></script>');
    expect(preview.content.csp).toContain("script-src 'unsafe-inline'");
    const resource = await fixture.service.bundleContent(artifact.artifactId, "assets/app.js", "local-admin");
    expect(resource.bytes.toString("utf8")).toContain("dataset.ready");
    const download = await fixture.service.download(artifact.artifactId, "local-admin");
    expect(download).toMatchObject({ mimeType: "application/zip", fileName: "互动页面.zip" });
    expect(download.bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(download.bytes.includes(Buffer.from("assets/app.js"))).toBe(true);
    const streamed = await fixture.service.downloadStream(artifact.artifactId, "local-admin");
    const chunks: Buffer[] = [];
    for await (const chunk of streamed.stream) chunks.push(Buffer.from(chunk));
    const streamedZip = Buffer.concat(chunks);
    expect(streamedZip.byteLength).toBe(streamed.byteLength);
    expect(streamedZip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(streamedZip.includes(Buffer.from("assets/app.js"))).toBe(true);
  });

  it("从既有 Artifact Blob 物化到新 Session，不读取来源 Workspace", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const fixture = await setup();
    const source = await workspace(fixture.workspaces, "session-source");
    await source.writeBytes("image.png", new Uint8Array([1, 2, 3, 4]));
    const artifact = await fixture.service.publishFile(input("session-source", "turn-a", "op-a", "image.png"));
    await rm(join(fixture.workspaces, "session-source"), { recursive: true, force: true });

    await fixture.service.materialize(artifact.artifactId, "local-admin", "session-target", "assets/reused.png");
    const target = await workspace(fixture.workspaces, "session-target");
    expect((await target.readBytes("assets/reused.png")).content).toEqual(Buffer.from([1, 2, 3, 4]));
    const republished = await fixture.service.publishFile(input("session-target", "turn-b", "op-b", "assets/reused.png"));
    expect(republished.primary.sha256).toBe(artifact.primary.sha256);
  });

  it("归档后仍可恢复和读取，Bundle 遇到符号链接时直接拒绝", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const fixture = await setup();
    const sandbox = await workspace(fixture.workspaces, "session-a");
    await sandbox.writeText("note.txt", "hello");
    const artifact = await fixture.service.publishFile(input("session-a", "turn-a", "op-a", "note.txt"));
    expect((await fixture.service.setState(artifact.artifactId, "local-admin", "archived")).state).toBe("archived");
    expect(await fixture.service.resolveMentions([artifact.artifactId], "local-admin")).toHaveLength(1);
    expect((await fixture.service.setState(artifact.artifactId, "local-admin", "active")).state).toBe("active");

    await sandbox.writeText("site/index.html", "<h1>unsafe</h1>");
    await symlink("index.html", join(fixture.workspaces, "session-a", "site", "linked.html"));
    await expect(fixture.service.publishHtmlBundle({
      ownerId: "local-admin", sessionId: "session-a", turnId: "turn-b", operationId: "op-b",
      rootPath: "site", entryPath: "index.html",
    })).rejects.toThrow("符号链接");
  });

  it("Blob 被破坏后直接失败，不回退到 Workspace", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const fixture = await setup();
    const sandbox = await workspace(fixture.workspaces, "session-a");
    await sandbox.writeText("note.txt", "original");
    const artifact = await fixture.service.publishFile(input("session-a", "turn-a", "op-a", "note.txt"));
    await writeFile(join(fixture.blobsRoot, artifact.primary.sha256), "corrupt");
    await expect(fixture.service.content(artifact.artifactId, "local-admin"))
      .rejects.toMatchObject({ code: "ARTIFACT_BLOB_CORRUPT" });
  });

  it("图片与 PDF 预览使用 inline raw 路由，下载仍由 content 路由负责", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const fixture = await setup();
    const sandbox = await workspace(fixture.workspaces, "session-media");
    await sandbox.writeBytes("poster.png", new Uint8Array([1, 2, 3, 4]));
    const artifact = await fixture.service.publishFile(input("session-media", "turn-media", "op-media", "poster.png"));
    const preview = await fixture.service.preview(artifact.artifactId, "local-admin", "https://preview.example.test/api/control/v1");

    expect(preview.content).toEqual({
      kind: "image",
      contentUrl: `https://preview.example.test/api/control/v1/artifacts/${artifact.artifactId}/raw`,
    });
    expect((await fixture.service.download(artifact.artifactId, "local-admin")).fileName).toBe("poster.png");
  });

  it("PPTX Artifact 返回浏览器渲染所需的原始内容地址", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const fixture = await setup();
    const sandbox = await workspace(fixture.workspaces, "session-pptx");
    await sandbox.writeBytes("deck.pptx", new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    const artifact = await fixture.service.publishFile(input("session-pptx", "turn-pptx", "op-pptx", "deck.pptx"));
    const preview = await fixture.service.preview(artifact.artifactId, "local-admin", "https://preview.example.test/api/control/v1");

    expect(artifact.primary.mimeType).toBe("application/vnd.openxmlformats-officedocument.presentationml.presentation");
    expect(preview.content).toEqual({
      kind: "pptx",
      contentUrl: `https://preview.example.test/api/control/v1/artifacts/${artifact.artifactId}/raw`,
    });
  });
});

/** 构造「input」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function input(sessionId: string, turnId: string, operationId: string, path: string) {
  return { ownerId: "local-admin", sessionId, turnId, operationId, path };
}

/** 构造「workspace」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async function workspace(root: string, sessionId: string): Promise<FileSandbox> {
  const sandbox = new FileSandbox(join(root, sessionId));
  await sandbox.initialize();
  return sandbox;
}

/** 构造「setup」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "mk-artifacts-"));
  dirs.push(dir);
  const workspaces = join(dir, "workspaces");
  const blobsRoot = join(dir, "blobs");
  return {
    workspaces,
    blobsRoot,
    service: new ArtifactService(
      new ArtifactRepository(join(dir, "artifacts.json")),
      new ArtifactBlobStore(blobsRoot),
      workspaces,
    ),
  };
}
