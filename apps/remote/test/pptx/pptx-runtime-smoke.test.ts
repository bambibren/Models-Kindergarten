import { randomBytes } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createZip } from "../../src/artifacts/zip-bundle.js";
import { runPptxRuntimeSmoke } from "../../src/pptx/pptx-runtime-smoke.js";
import type { PptxProcessRunner } from "../../src/pptx/pptx-build-service.js";

describe("PPTX runtime smoke", () => {
  it("通过真实构建服务校验依赖合同并清理临时 Workspace", async () => {
    let workspaceRoot = "";
    const runner: PptxProcessRunner = {
      async run(input) {
        workspaceRoot = input.workspaceRoot;
        const source = await readFile(input.sourcePath, "utf8");
        expect(source).toContain('require("pptxgenjs")');
        expect(source).toContain('require("jszip")');
        await writeFile(input.outputPath, validPptx());
        return { exitCode: 0, signal: null, stdout: "smoke", stderr: "", truncated: false };
      },
    };

    await expect(runPptxRuntimeSmoke(runner)).resolves.toMatchObject({
      slides: 1,
      byteLength: validPptx().byteLength,
    });
    await expect(access(workspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function validPptx(): Buffer {
  return createZip([
    { path: "[Content_Types].xml", bytes: Buffer.from("<Types/>") },
    { path: "_rels/.rels", bytes: Buffer.from("<Relationships/>") },
    { path: "ppt/presentation.xml", bytes: Buffer.from("<p:presentation/>") },
    { path: "ppt/_rels/presentation.xml.rels", bytes: Buffer.from("<Relationships/>") },
    { path: "ppt/slides/slide1.xml", bytes: Buffer.from("<p:sld/>") },
    { path: "ppt/media/smoke.bin", bytes: randomBytes(12_000) },
  ]);
}
