import { describe, expect, it } from "vitest";
import { createZip } from "../../src/artifacts/zip-bundle.js";
import { inspectPptx } from "../../src/pptx/pptx-inspector.js";

describe("inspectPptx", () => {
  it("读取 central directory 并统计幻灯片", () => {
    expect(inspectPptx(validPptx(2))).toEqual({ slides: 2, entries: 6 });
  });

  it("拒绝损坏 ZIP、普通 ZIP 和没有幻灯片的 OOXML", () => {
    expect(() => inspectPptx(Buffer.from("not-a-zip"))).toThrow("PPTX_STRUCTURE_INVALID");
    expect(() => inspectPptx(createZip([{ path: "hello.txt", bytes: Buffer.from("hello") }]))).toThrow("PPTX_STRUCTURE_INVALID");
    expect(() => inspectPptx(createZip(requiredEntries()))).toThrow("PPTX_STRUCTURE_INVALID");
  });
});

function validPptx(slides: number): Buffer {
  return createZip([
    ...requiredEntries(),
    ...Array.from({ length: slides }, (_, index) => ({
      path: `ppt/slides/slide${index + 1}.xml`,
      bytes: Buffer.from(`<p:sld id="${index + 1}"/>`),
    })),
  ]);
}

function requiredEntries(): Array<{ path: string; bytes: Buffer }> {
  return [
    { path: "[Content_Types].xml", bytes: Buffer.from("<Types/>") },
    { path: "_rels/.rels", bytes: Buffer.from("<Relationships/>") },
    { path: "ppt/presentation.xml", bytes: Buffer.from("<p:presentation/>") },
    { path: "ppt/_rels/presentation.xml.rels", bytes: Buffer.from("<Relationships/>") },
  ];
}
