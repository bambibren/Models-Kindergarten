import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactBlobStore } from "../../src/artifacts/artifact-blob-store.js";
import { ArtifactRepository } from "../../src/artifacts/artifact-repository.js";
import { ArtifactService } from "../../src/artifacts/artifact-service.js";
import { ArtifactToolProvider } from "../../src/artifacts/artifact-tool-provider.js";
import type { TurnScope } from "../../src/runtime/turn-scope.js";
import { FileSandbox } from "../../src/tools/sandbox.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import { ToolCallLedger, ToolRuntime, type ToolObserver } from "../../src/tools/tool-runtime.js";

const dirs: string[] = [];
afterEach(/** 在每个测试后释放临时资源，保证后续场景从干净状态开始。 */
async () => Promise.all(dirs.splice(0).map(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(dir) => rm(dir, { recursive: true, force: true }))));

describe("HTML Artifact chain", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("允许配置的文件写入无需确认，并发布可执行的 HTML Bundle", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const dir = await mkdtemp(join(tmpdir(), "mk-html-chain-"));
    dirs.push(dir);
    const workspaces = join(dir, "workspaces");
    const sandbox = new FileSandbox(join(workspaces, "session-html"));
    await sandbox.initialize();
    const service = new ArtifactService(
      new ArtifactRepository(join(dir, "artifacts.json")),
      new ArtifactBlobStore(join(dir, "blobs")),
      workspaces,
    );
    const permission = vi.fn(/** 构造「permission」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => true);
    const observer: ToolObserver = {
      toolExecutionStarted: /** 构造工具实际执行开始的测试观察器。 */
async () => undefined,
      toolFinish: /** 构造「toolFinish」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => undefined,
      requestPermission: permission,
      askUser: /** 构造「askUser」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => "",
    };
    const builtinBindings = new Map([
      ["write_file", { enabled: true, permission: "allow" as const }],
    ]);
    const builtin = new ToolRegistry(sandbox, undefined, undefined, builtinBindings);
    const writeCalls = [
      builtin.prepare({
        id: "write-html",
        name: "write_file",
        arguments: {
          path: "site/index.html",
          content: "<!doctype html><html><head></head><body><button id=go>运行</button><script src=app.js></script></body></html>",
        },
      }, "fallback"),
      builtin.prepare({
        id: "write-js",
        name: "write_file",
        arguments: { path: "site/app.js", content: "document.body.dataset.motion = 'ready'" },
      }, "fallback"),
    ];
    const writes = await new ToolRuntime(builtin).executeBatch(
      writeCalls,
      observer,
      new ToolCallLedger(),
      new AbortController().signal,
    );

    expect(writes.outcomes.map(/** 构造「toEqual」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(item) => item.status)).toEqual(["success", "success"]);
    expect(writeCalls.every(/** 构造「toBe」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(call) => call.locations.length === 0)).toBe(true);
    expect(writes.outcomes.every(/** 构造「toBe」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(item) => item.locations.length === 0)).toBe(true);
    expect(writes.outcomes.every(/** 构造「toBe」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(item) => item.modelContent.includes("not published"))).toBe(true);
    expect(permission).not.toHaveBeenCalled();

    const artifactBindings = new Map([
      ["publish_artifact", { enabled: true, permission: "allow" as const }],
    ]);
    const artifactProvider = new ArtifactToolProvider(service, scope(), artifactBindings);
    const publish = artifactProvider.prepare({
      id: "publish-html",
      name: "publish_artifact",
      arguments: { artifact_type: "html_bundle", root_path: "site", entry_path: "index.html", display_name: "动效页面" },
    }, "fallback");
    expect(publish.locations).toEqual([]);
    expect(artifactProvider.definitions[0]?.function.description).toContain("成功发布");
    const published = await new ToolRuntime(artifactProvider).executeBatch(
      [publish],
      observer,
      new ToolCallLedger(),
      new AbortController().signal,
    );
    const artifactId = (published.outcomes[0]?.rawOutput as { artifactId: string }).artifactId;
    const preview = await service.preview(artifactId, "local-admin", "http://127.0.0.1:7331/api/control/v1");

    expect(published.outcomes[0]).toMatchObject({ status: "success" });
    expect(permission).not.toHaveBeenCalled();
    expect(preview.content).toMatchObject({ kind: "static_html" });
    if (preview.content.kind !== "static_html") throw new Error("预览类型错误");
    expect(preview.content.html).toContain("<script src=app.js></script>");
    expect((await service.bundleContent(artifactId, "app.js", "local-admin")).bytes.toString("utf8"))
      .toContain("dataset.motion");
  });
});

/** 构造「scope」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function scope(): TurnScope {
  return {
    schemaVersion: 1,
    ownerId: "local-admin",
    sessionId: "session-html",
    turnId: "turn-html",
    operationId: "operation-html",
    purpose: "chat",
    modelStudentId: "student-big-brain",
    agentId: "agent-html",
  };
}
