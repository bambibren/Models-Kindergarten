import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { FileSandbox } from "../tools/sandbox.js";
import {
  PptxBuildService,
  type PptxProcessRunner,
} from "./pptx-build-service.js";

export interface PptxRuntimeSmokeResult {
  sha256: string;
  byteLength: number;
  slides: number;
  entries: number;
}

/** 用真实 PPTX 构建链验证 Linux 沙箱与运行时依赖；临时文件不会发布为 Artifact。 */
export async function runPptxRuntimeSmoke(
  runner?: PptxProcessRunner,
): Promise<PptxRuntimeSmokeResult> {
  const root = await mkdtemp(join(tmpdir(), "mk-pptx-runtime-smoke-"));
  try {
    const files = new FileSandbox(root);
    await files.initialize();
    await files.writeText("smoke.cjs", `
const fs = require("node:fs/promises");
const PptxGenJS = require("pptxgenjs");
const JSZip = require("jszip");

async function main() {
  const deck = new PptxGenJS();
  deck.layout = "LAYOUT_WIDE";
  deck.addSlide().addText("MK PPTX runtime smoke", {
    x: 1, y: 1, w: 6, h: 1, fontSize: 28,
  });
  await deck.writeFile({ fileName: "smoke.pptx" });
  const zip = await JSZip.loadAsync(await fs.readFile("smoke.pptx"));
  if (!zip.file("ppt/presentation.xml") || !zip.file("ppt/slides/slide1.xml")) {
    throw new Error("PPTX OOXML smoke entries 缺失");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`);
    const result = await new PptxBuildService(files, runner).build({
      sourcePath: "smoke.cjs",
      outputPath: "smoke.pptx",
    }, new AbortController().signal);
    if (result.slides !== 1 || result.entries < 1 || result.byteLength <= 10_000) {
      throw new Error("PPTX runtime smoke 产物结构无效");
    }
    return {
      sha256: result.sha256,
      byteLength: result.byteLength,
      slides: result.slides,
      entries: result.entries,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPptxRuntimeSmoke()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
