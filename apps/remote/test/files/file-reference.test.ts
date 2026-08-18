import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileReferenceRepository } from "../../src/files/file-reference-repository.js";
import { FileReferenceService } from "../../src/files/file-reference-service.js";
import { FileSandbox } from "../../src/tools/sandbox.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("FileReferenceService", () => {
  it("从 Session workspace 创建 opaque 引用并持久预览", async () => {
    const { service, workspaces } = await setup();
    const sandbox = new FileSandbox(join(workspaces, "session-a"));
    await sandbox.initialize();
    await sandbox.writeText("report.md", "# 结果\n完成");
    const [file] = await service.createFromPaths("local-admin", "session-a", "turn-a", ["report.md"]);
    expect(file?.fileReferenceId).toMatch(/^file_[a-f0-9]{32}$/);
    expect(file).not.toHaveProperty("absolutePath");
    expect((await service.preview(file!.fileReferenceId)).content).toEqual({ kind: "markdown", markdown: "# 结果\n完成" });
    await expect(service.get(file!.fileReferenceId, "another-owner")).rejects.toMatchObject({ code: "FILE_REFERENCE_FORBIDDEN" });
  });

  it("HTML 预览保留脚本与交互元素，并通过 CSP 保持隔离边界", async () => {
    const { service, workspaces } = await setup();
    const sandbox = new FileSandbox(join(workspaces, "session-a"));
    await sandbox.initialize();
    const html = `<button id="run">运行</button><script>document.querySelector('#run').onclick = () => document.body.dataset.executed = 'yes'</script>`;
    await sandbox.writeText("interactive.html", html);
    const [file] = await service.createFromPaths("local-admin", "session-a", "turn-a", ["interactive.html"]);
    const preview = await service.preview(file!.fileReferenceId);

    expect(preview.content).toMatchObject({ kind: "static_html", html });
    if (preview.content.kind !== "static_html") throw new Error("预览类型错误");
    expect(preview.content.csp).toContain("script-src 'unsafe-inline'");
    expect(preview.content.csp).toContain("frame-src 'none'");
    expect(preview.content.csp).toContain("object-src 'none'");
    expect(preview.content.csp).toContain("form-action 'none'");
  });

  it("不接受穿越 Session workspace 的路径", async () => {
    const { service } = await setup();
    await expect(service.createFromPaths("local-admin", "session-a", "turn-a", ["../secret.txt"]))
      .rejects.toThrow(/path|路径/);
  });

  it("同一 Turn 同一路径内容未变时复用引用，内容变化时创建新快照", async () => {
    const { service, workspaces } = await setup();
    const sandbox = new FileSandbox(join(workspaces, "session-a"));
    await sandbox.initialize();
    await sandbox.writeText("index.html", "<h1>第一版</h1>");
    const [first] = await service.createFromPaths("local-admin", "session-a", "turn-a", ["index.html"]);
    const [same] = await service.createFromPaths("local-admin", "session-a", "turn-a", ["index.html"]);

    await sandbox.writeText("index.html", "<h1>第二版</h1>");
    const [second] = await service.createFromPaths("local-admin", "session-a", "turn-a", ["index.html"]);

    expect(same?.fileReferenceId).toBe(first?.fileReferenceId);
    expect(second?.fileReferenceId).not.toBe(first?.fileReferenceId);
    expect((await service.preview(first!.fileReferenceId)).content).toEqual({ kind: "static_html", html: "<h1>第一版</h1>", csp: expect.any(String) });
    expect((await service.preview(second!.fileReferenceId)).content).toEqual({ kind: "static_html", html: "<h1>第二版</h1>", csp: expect.any(String) });
  });

  it("PPTX Session 文件允许通过受控内容端点交给浏览器渲染", async () => {
    const { service, workspaces } = await setup();
    const sandbox = new FileSandbox(join(workspaces, "session-pptx"));
    await sandbox.initialize();
    await sandbox.writeBytes("deck.pptx", new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    const [file] = await service.createFromPaths("local-admin", "session-pptx", "turn-pptx", ["deck.pptx"]);

    expect(file).toMatchObject({
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      previewKind: "pptx",
    });
    expect((await service.preview(file!.fileReferenceId)).content).toEqual({
      kind: "pptx",
      contentUrl: `/api/control/v1/files/${file!.fileReferenceId}/content`,
    });
    expect((await service.content(file!.fileReferenceId)).bytes).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  });
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "mk-files-"));
  dirs.push(dir);
  const workspaces = join(dir, "workspaces");
  return {
    workspaces,
    service: new FileReferenceService(
      new FileReferenceRepository(join(dir, "references.json")),
      workspaces,
      join(dir, "blobs"),
    ),
  };
}
