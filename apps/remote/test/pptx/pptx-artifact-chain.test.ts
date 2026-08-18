import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactBlobStore } from "../../src/artifacts/artifact-blob-store.js";
import { ArtifactRepository } from "../../src/artifacts/artifact-repository.js";
import { ArtifactService } from "../../src/artifacts/artifact-service.js";
import { ArtifactToolProvider } from "../../src/artifacts/artifact-tool-provider.js";
import { createZip } from "../../src/artifacts/zip-bundle.js";
import { PptxBuildService, type PptxProcessRunner } from "../../src/pptx/pptx-build-service.js";
import { PptxToolProvider } from "../../src/pptx/pptx-tool-provider.js";
import type { TurnScope } from "../../src/runtime/turn-scope.js";
import { FileSandbox } from "../../src/tools/sandbox.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("PPTX Artifact chain", () => {
  it("构建、发布、下载和 Mention 物化保持同一 PPTX 字节", async () => {
    const root = await mkdtemp(join(tmpdir(), "mk-pptx-artifact-"));
    dirs.push(root);
    const workspaces = join(root, "workspaces");
    const files = new FileSandbox(join(workspaces, "session-a"));
    await files.initialize();
    await files.writeText("deck/generate.cjs", "// PptxGenJS source");
    const pptxBytes = validPptx();
    const runner: PptxProcessRunner = {
      run: async (input) => {
        await writeFile(input.outputPath, pptxBytes);
        return { exitCode: 0, signal: null, stdout: "", stderr: "", truncated: false };
      },
    };
    const pptxProvider = new PptxToolProvider(
      new PptxBuildService(files, runner),
      new Map([["build_pptx", { enabled: true, permission: "allow" }]]),
    );
    const built = await pptxProvider.execute(pptxProvider.prepare({
      id: "build",
      name: "build_pptx",
      arguments: { source_path: "deck/generate.cjs", output_path: "deck/final.pptx" },
    }, "fallback"), context());
    expect(built.effects?.fileRelativePaths).toEqual(["deck/final.pptx"]);
    expect(built.content).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ content: expect.objectContaining({ type: "resource_link" }) }),
    ]));

    const artifacts = new ArtifactService(
      new ArtifactRepository(join(root, "artifacts.json")),
      new ArtifactBlobStore(join(root, "blobs")),
      workspaces,
    );
    const artifactProvider = new ArtifactToolProvider(
      artifacts,
      scope("session-a", "turn-a"),
      new Map([
        ["publish_artifact", { enabled: true, permission: "allow" }],
        ["read_artifact", { enabled: true, permission: "allow" }],
      ]),
    );
    const published = await artifactProvider.execute(artifactProvider.prepare({
      id: "publish",
      name: "publish_artifact",
      arguments: { artifact_type: "file", path: "deck/final.pptx", display_name: "演示文稿.pptx" },
    }, "fallback"), context());
    const artifactId = (published.rawOutput as { artifactId: string }).artifactId;
    expect(published.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: expect.objectContaining({ type: "resource_link", uri: `artifact://${artifactId}` }) }),
    ]));
    const download = await artifacts.download(artifactId, "local-admin");
    expect(download).toMatchObject({
      fileName: "演示文稿.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
    expect(download.bytes.equals(pptxBytes)).toBe(true);

    const reader = new ArtifactToolProvider(
      artifacts,
      scope("session-b", "turn-b"),
      new Map([["read_artifact", { enabled: true, permission: "allow" }]]),
    );
    const reused = await reader.execute(reader.prepare({
      id: "read",
      name: "read_artifact",
      arguments: { artifact_id: artifactId, target_path: "inputs/reused.pptx" },
    }, "fallback"), context());
    expect(reused.rawOutput).toMatchObject({ reusedBlob: true, targetPath: "inputs/reused.pptx" });
    expect((await readFile(join(workspaces, "session-b", "inputs/reused.pptx"))).equals(pptxBytes)).toBe(true);
    expect((await files.walkFiles()).map((item) => item.path).toSorted()).toEqual([
      "deck/final.pptx",
      "deck/generate.cjs",
    ]);
  });
});

function context() {
  return { signal: new AbortController().signal, askUser: async () => "" };
}

function scope(sessionId: string, turnId: string): TurnScope {
  return {
    schemaVersion: 1,
    ownerId: "local-admin",
    sessionId,
    turnId,
    operationId: `operation-${turnId}`,
    purpose: "chat",
    modelStudentId: "student-a",
    agentId: "agent-a",
  };
}

function validPptx(): Buffer {
  return createZip([
    { path: "[Content_Types].xml", bytes: Buffer.from("<Types/>") },
    { path: "_rels/.rels", bytes: Buffer.from("<Relationships/>") },
    { path: "ppt/presentation.xml", bytes: Buffer.from("<p:presentation/>") },
    { path: "ppt/_rels/presentation.xml.rels", bytes: Buffer.from("<Relationships/>") },
    { path: "ppt/slides/slide1.xml", bytes: Buffer.from("<p:sld/>") },
  ]);
}
