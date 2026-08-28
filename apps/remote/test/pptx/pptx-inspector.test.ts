import { describe, expect, it } from "vitest";
import { createZip } from "../../src/artifacts/zip-bundle.js";
import { inspectPptx } from "../../src/pptx/pptx-inspector.js";

describe("inspectPptx", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("读取 central directory 并统计幻灯片", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    expect(inspectPptx(validPptx(2))).toEqual({ slides: 2, entries: 6 });
  });

  it("拒绝损坏 ZIP、普通 ZIP 和没有幻灯片的 OOXML", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    expect(/** 构造「toThrow」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => inspectPptx(Buffer.from("not-a-zip"))).toThrow("PPTX_STRUCTURE_INVALID");
    expect(/** 构造「toThrow」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => inspectPptx(createZip([{ path: "hello.txt", bytes: Buffer.from("hello") }]))).toThrow("PPTX_STRUCTURE_INVALID");
    expect(/** 构造「toThrow」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => inspectPptx(createZip(requiredEntries()))).toThrow("PPTX_STRUCTURE_INVALID");
  });
});

/** 构造「validPptx」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function validPptx(slides: number): Buffer {
  return createZip([
    ...requiredEntries(),
    ...Array.from({ length: slides }, /** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(_, index) => ({
      path: `ppt/slides/slide${index + 1}.xml`,
      bytes: Buffer.from(`<p:sld id="${index + 1}"/>`),
    })),
  ]);
}

/** 构造「requiredEntries」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function requiredEntries(): Array<{ path: string; bytes: Buffer }> {
  return [
    { path: "[Content_Types].xml", bytes: Buffer.from("<Types/>") },
    { path: "_rels/.rels", bytes: Buffer.from("<Relationships/>") },
    { path: "ppt/presentation.xml", bytes: Buffer.from("<p:presentation/>") },
    { path: "ppt/_rels/presentation.xml.rels", bytes: Buffer.from("<Relationships/>") },
  ];
}
