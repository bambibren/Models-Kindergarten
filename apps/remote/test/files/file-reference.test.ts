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
