/** 描述「PptxInspection」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface PptxInspection {
  slides: number;
  entries: number;
}

const END_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_MIN_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;

/**
 * 只读取 ZIP central directory，确认文件是包含幻灯片的基础 OOXML 包。
 * 这里不解压正文、不渲染页面，也不生成旁路检查文件。
 */
export function inspectPptx(bytes: Buffer): PptxInspection {
  const endOffset = findEnd(bytes);
  const entries = bytes.readUInt16LE(endOffset + 10);
  const centralBytes = bytes.readUInt32LE(endOffset + 12);
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  if (entries < 1 || centralOffset + centralBytes > endOffset) invalid("ZIP central directory 越界");

  const names = new Set<string>();
  let offset = centralOffset;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > bytes.byteLength || bytes.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      invalid("ZIP central directory 条目损坏");
    }
    const nameBytes = bytes.readUInt16LE(offset + 28);
    const extraBytes = bytes.readUInt16LE(offset + 30);
    const commentBytes = bytes.readUInt16LE(offset + 32);
    const end = offset + 46 + nameBytes + extraBytes + commentBytes;
    if (nameBytes < 1 || end > bytes.byteLength) invalid("ZIP central directory 文件名损坏");
    const name = bytes.subarray(offset + 46, offset + 46 + nameBytes).toString("utf8");
    if (names.has(name)) invalid(`ZIP 包含重复条目: ${name}`);
    names.add(name);
    offset = end;
  }
  if (offset !== centralOffset + centralBytes) invalid("ZIP central directory 长度不一致");

  for (const required of [
    "[Content_Types].xml",
    "_rels/.rels",
    "ppt/presentation.xml",
    "ppt/_rels/presentation.xml.rels",
  ]) {
    if (!names.has(required)) invalid(`缺少 OOXML 条目: ${required}`);
  }
  const slides = [...names].filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(name) => /^ppt\/slides\/slide[1-9]\d*\.xml$/.test(name)).length;
  if (slides < 1) invalid("PPTX 不包含幻灯片");
  return { slides, entries };
}

/** 读取「findEnd」所需数据，并遵守作用域、分页与容量边界。 */
function findEnd(bytes: Buffer): number {
  if (bytes.byteLength < END_MIN_BYTES) invalid("文件不是有效 ZIP");
  const start = Math.max(0, bytes.byteLength - END_MIN_BYTES - MAX_COMMENT_BYTES);
  for (let offset = bytes.byteLength - END_MIN_BYTES; offset >= start; offset -= 1) {
    if (bytes.readUInt32LE(offset) !== END_SIGNATURE) continue;
    const commentBytes = bytes.readUInt16LE(offset + 20);
    if (offset + END_MIN_BYTES + commentBytes === bytes.byteLength) return offset;
  }
  invalid("找不到 ZIP end of central directory");
}

/** 执行「invalid」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function invalid(detail: string): never {
  throw new Error(`PPTX_STRUCTURE_INVALID: ${detail}`);
}
