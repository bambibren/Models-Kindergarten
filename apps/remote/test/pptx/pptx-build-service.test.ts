import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createZip } from "../../src/artifacts/zip-bundle.js";
import {
  PptxBuildService,
  type PptxProcessRunner,
} from "../../src/pptx/pptx-build-service.js";
import { FileSandbox } from "../../src/tools/sandbox.js";

const dirs: string[] = [];
afterEach(/** 在每个测试后释放临时资源，保证后续场景从干净状态开始。 */
async () => Promise.all(dirs.splice(0).map(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(dir) => rm(dir, { recursive: true, force: true }))));

describe("PptxBuildService", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it.runIf(process.platform === "darwin")("使用真实 PptxGenJS 在 macOS 受控进程中生成 PPTX", /** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
async () => {
    const { files } = await workspace();
    await files.writeText("deck/generate.cjs", `
const pptxgen = require("pptxgenjs");
const pptx = new pptxgen();
pptx.layout = "LAYOUT_WIDE";
const slide = pptx.addSlide();
slide.addText("MK PPTX runtime", { x: 1, y: 1, w: 6, h: 1, fontSize: 28 });
pptx.writeFile({ fileName: "deck/real.pptx" }).catch((error) => { console.error(error); process.exit(1); });
`);
    const result = await new PptxBuildService(files).build({
      sourcePath: "deck/generate.cjs",
      outputPath: "deck/real.pptx",
    }, signal());
    expect(result.slides).toBe(1);
    expect(result.byteLength).toBeGreaterThan(10_000);
  });

  it("执行源码并返回指定 PPTX 的哈希、字节和页数", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const { files, root } = await workspace();
    await files.writeText("deck/generate.cjs", "// generated source");
    const runner: PptxProcessRunner = {
      run: /** 构造「run」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async (input) => {
        await writeFile(input.outputPath, validPptx());
        return { exitCode: 0, signal: null, stdout: "built", stderr: "", truncated: false };
      },
    };
    const result = await new PptxBuildService(files, runner).build({
      sourcePath: "deck/generate.cjs",
      outputPath: "deck/final.pptx",
    }, new AbortController().signal);

    expect(result).toMatchObject({
      sourcePath: "deck/generate.cjs",
      outputPath: "deck/final.pptx",
      byteLength: validPptx().byteLength,
      slides: 1,
      stdout: "built",
    });
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(root).toContain("mk-pptx-build-");
  });

  it("拒绝非法扩展名、同一路径和损坏输出", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const { files } = await workspace();
    await files.writeText("deck/source.txt", "bad");
    const runner: PptxProcessRunner = {
      run: /** 构造「run」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async (input) => {
        await writeFile(input.outputPath, Buffer.from("not-pptx"));
        return { exitCode: 0, signal: null, stdout: "", stderr: "", truncated: false };
      },
    };
    const service = new PptxBuildService(files, runner);
    await expect(service.build({ sourcePath: "deck/source.txt", outputPath: "deck/final.pptx" }, signal()))
      .rejects.toThrow("PPTX_SOURCE_INVALID");
    await files.writeText("deck/source.cjs", "source");
    await expect(service.build({ sourcePath: "deck/source.cjs", outputPath: "deck/source.cjs" }, signal()))
      .rejects.toThrow("PPTX_OUTPUT_INVALID");
    await expect(service.build({ sourcePath: "deck/source.cjs", outputPath: "deck/final.pptx" }, signal()))
      .rejects.toThrow("PPTX_STRUCTURE_INVALID");
  });

  it("非零退出、超时和取消直接失败且不自动重试", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const { files } = await workspace();
    await files.writeText("deck/source.cjs", "source");
    let calls = 0;
    const runner: PptxProcessRunner = {
      run: /** 构造「run」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => {
        calls += 1;
        return { exitCode: 1, signal: null, stdout: "", stderr: "boom", truncated: false };
      },
    };
    await expect(new PptxBuildService(files, runner).build({
      sourcePath: "deck/source.cjs", outputPath: "deck/final.pptx",
    }, signal())).rejects.toThrow("PPTX_BUILD_FAILED");
    expect(calls).toBe(1);

    const cancelled = new AbortController();
    cancelled.abort();
    await expect(new PptxBuildService(files, runner).build({
      sourcePath: "deck/source.cjs", outputPath: "deck/final.pptx",
    }, cancelled.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
  });
});

/** 构造「workspace」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async function workspace(): Promise<{ root: string; files: FileSandbox }> {
  const root = await mkdtemp(join(tmpdir(), "mk-pptx-build-"));
  dirs.push(root);
  const files = new FileSandbox(root);
  await files.initialize();
  return { root, files };
}

/** 构造「signal」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function signal(): AbortSignal {
  return new AbortController().signal;
}

/** 构造「validPptx」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function validPptx(): Buffer {
  return createZip([
    { path: "[Content_Types].xml", bytes: Buffer.from("<Types/>") },
    { path: "_rels/.rels", bytes: Buffer.from("<Relationships/>") },
    { path: "ppt/presentation.xml", bytes: Buffer.from("<p:presentation/>") },
    { path: "ppt/_rels/presentation.xml.rels", bytes: Buffer.from("<Relationships/>") },
    { path: "ppt/slides/slide1.xml", bytes: Buffer.from("<p:sld/>") },
  ]);
}
