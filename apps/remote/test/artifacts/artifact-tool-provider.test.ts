import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactBlobStore } from "../../src/artifacts/artifact-blob-store.js";
import { ArtifactRepository } from "../../src/artifacts/artifact-repository.js";
import { ArtifactService } from "../../src/artifacts/artifact-service.js";
import { ARTIFACT_TOOL_IDS, ArtifactToolProvider } from "../../src/artifacts/artifact-tool-provider.js";
import type { TurnScope } from "../../src/runtime/turn-scope.js";
import { FileSandbox } from "../../src/tools/sandbox.js";
import { ToolCallLedger, ToolRuntime } from "../../src/tools/tool-runtime.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("ArtifactToolProvider", () => {
  it("只暴露统一发布、服务端新版本和显式回滚工具", () => {
    expect(ARTIFACT_TOOL_IDS).toEqual([
      "read_artifact",
      "publish_artifact",
      "publish_artifact_version",
      "rollback_artifact",
    ]);
  });

  it("Agent 配置 allow 时不询问 permission，并发布 resource_link", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mk-artifact-tool-"));
    dirs.push(dir);
    const workspaces = join(dir, "workspaces");
    const sandbox = new FileSandbox(join(workspaces, "session-a"));
    await sandbox.initialize();
    await sandbox.writeText("index.html", "<h1>hello</h1>");
    const service = new ArtifactService(
      new ArtifactRepository(join(dir, "artifacts.json")),
      new ArtifactBlobStore(join(dir, "blobs")),
      workspaces,
    );
    const bindings = new Map([
      ["publish_artifact", { enabled: true, permission: "allow" as const }],
    ]);
    const provider = new ArtifactToolProvider(service, scope(), bindings);
    const call = provider.prepare({
      id: "publish-once",
      name: "publish_artifact",
      arguments: { artifact_type: "file", path: "index.html" },
    }, "fallback");
    expect(call.locations).toEqual([]);
    expect(provider.definitions[0]?.function.description).toContain("成功发布");
    expect(provider.definitions[0]?.function.description).toContain("预览");
    const requestPermission = vi.fn(async () => true);
    const result = await new ToolRuntime(provider).executeBatch([call], {
      toolStart: async () => undefined,
      toolFinish: async () => undefined,
      requestPermission,
      askUser: async () => "",
    }, new ToolCallLedger(), new AbortController().signal);

    expect(requestPermission).not.toHaveBeenCalled();
    expect(result.outcomes[0]).toMatchObject({ status: "success", rawOutput: { artifactId: expect.stringMatching(/^artifact_/) } });
    expect(result.outcomes[0]?.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: expect.objectContaining({ type: "resource_link", uri: expect.stringMatching(/^artifact:\/\//) }) }),
    ]));
    expect(result.outcomes[0]?.modelContent).toContain("Only this successfully published Artifact");

    const retryScope = { ...scope(), turnId: "turn-retry", operationId: "same-user-operation" };
    const firstProvider = new ArtifactToolProvider(service, retryScope, bindings);
    const first = await firstProvider.execute(firstProvider.prepare({ id: "model-call-a", name: "publish_artifact", arguments: { artifact_type: "file", path: "index.html" } }, "fallback"), { signal: new AbortController().signal, askUser: async () => "" });
    const secondProvider = new ArtifactToolProvider(service, { ...retryScope, turnId: "turn-retry-2" }, bindings);
    const second = await secondProvider.execute(secondProvider.prepare({ id: "model-call-b", name: "publish_artifact", arguments: { artifact_type: "file", path: "index.html" } }, "fallback"), { signal: new AbortController().signal, askUser: async () => "" });
    expect(second.rawOutput).toMatchObject({ artifactId: (first.rawOutput as { artifactId: string }).artifactId });
  });

  it("覆盖保持 ID，新版本获得新 ID，回滚只恢复隐藏修订", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mk-artifact-version-tool-"));
    dirs.push(dir);
    const workspaces = join(dir, "workspaces");
    const sandbox = new FileSandbox(join(workspaces, "session-a"));
    await sandbox.initialize();
    await sandbox.writeText("page.html", "first");
    const service = new ArtifactService(
      new ArtifactRepository(join(dir, "artifacts.json")),
      new ArtifactBlobStore(join(dir, "blobs")),
      workspaces,
    );
    const bindings = new Map(ARTIFACT_TOOL_IDS.map((toolId) => [
      toolId,
      { enabled: true, permission: "allow" as const },
    ]));
    const firstProvider = new ArtifactToolProvider(service, scope(), bindings);
    const first = await firstProvider.execute(firstProvider.prepare({
      id: "create-v1", name: "publish_artifact",
      arguments: { artifact_type: "file", path: "page.html" },
    }, "fallback"), context());
    const artifactId = (first.rawOutput as { artifactId: string }).artifactId;

    await sandbox.writeText("page.html", "second");
    const replaceProvider = new ArtifactToolProvider(service, { ...scope(), turnId: "turn-b", operationId: "operation-b" }, bindings);
    const replaced = await replaceProvider.execute(replaceProvider.prepare({
      id: "replace-v1", name: "publish_artifact",
      arguments: { artifact_type: "file", artifact_id: artifactId, path: "page.html" },
    }, "fallback"), context());
    const versionProvider = new ArtifactToolProvider(service, { ...scope(), turnId: "turn-c", operationId: "operation-c" }, bindings);
    const versioned = await versionProvider.execute(versionProvider.prepare({
      id: "create-v2", name: "publish_artifact_version",
      arguments: { artifact_type: "file", artifact_id: artifactId, path: "page.html" },
    }, "fallback"), context());
    const rollbackProvider = new ArtifactToolProvider(service, { ...scope(), turnId: "turn-d", operationId: "operation-d" }, bindings);
    const rolledBack = await rollbackProvider.execute(rollbackProvider.prepare({
      id: "rollback-v1", name: "rollback_artifact",
      arguments: { artifact_id: artifactId, steps: 1 },
    }, "fallback"), context());

    expect(replaced.rawOutput).toMatchObject({ artifactId, version: 1, publication: "replaced" });
    expect(versioned.rawOutput).toMatchObject({ version: 2, publication: "versioned" });
    expect((versioned.rawOutput as { artifactId: string }).artifactId).not.toBe(artifactId);
    expect(rolledBack.rawOutput).toMatchObject({ artifactId, version: 1, publication: "rolled_back" });
    expect((await service.content(artifactId, "local-admin")).bytes.toString()).toBe("first");
  });
});

function context() {
  return { signal: new AbortController().signal, askUser: async () => "" };
}

function scope(): TurnScope {
  return {
    schemaVersion: 1, ownerId: "local-admin", sessionId: "session-a", turnId: "turn-a", operationId: "operation-a",
    purpose: "chat", modelStudentId: "student-a", agentId: "agent-a",
  };
}
