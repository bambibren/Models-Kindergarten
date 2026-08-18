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
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("HTML Artifact chain", () => {
  it("允许配置的文件写入无需确认，并发布可执行的 HTML Bundle", async () => {
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
    const permission = vi.fn(async () => true);
    const observer: ToolObserver = {
      toolStart: async () => undefined,
      toolFinish: async () => undefined,
      requestPermission: permission,
      askUser: async () => "",
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

    expect(writes.outcomes.map((item) => item.status)).toEqual(["success", "success"]);
    expect(writeCalls.every((call) => call.locations.length === 0)).toBe(true);
    expect(writes.outcomes.every((item) => item.locations.length === 0)).toBe(true);
    expect(writes.outcomes.every((item) => item.modelContent.includes("not published"))).toBe(true);
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
