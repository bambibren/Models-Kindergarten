import { Readable } from "node:stream";

/** 无压缩 ZIP writer：不依赖宿主机 zip 命令，HTML Bundle 下载在云端也保持可移植。 */
export function createZip(files: Array<{ path: string; bytes: Uint8Array }>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path, "utf8");
    const bytes = Buffer.from(file.bytes);
    const crc = crc32(bytes);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(bytes.byteLength, 18);
    localHeader.writeUInt32LE(bytes.byteLength, 22);
    localHeader.writeUInt16LE(name.byteLength, 26);
    local.push(localHeader, name, bytes);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(bytes.byteLength, 20);
    centralHeader.writeUInt32LE(bytes.byteLength, 24);
    centralHeader.writeUInt16LE(name.byteLength, 28);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, name);
    offset += localHeader.byteLength + name.byteLength + bytes.byteLength;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBytes.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

/** 描述「ZipStreamFile」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ZipStreamFile {
  path: string;
  byteLength: number;
  open: () => AsyncIterable<Uint8Array>;
}

/**
 * ZIP 流只常驻中央目录元数据；每个文件的正文读取完成后立即向下游释放。
 * 使用 Data Descriptor 后，本地文件头无需预先知道 CRC32。
 */
export function createZipStream(files: ZipStreamFile[]): { stream: Readable; byteLength: number } {
  const byteLength = zipStreamByteLength(files);
  return { stream: Readable.from(generateZip(files)), byteLength };
}

/** 逐文件生成 ZIP，各正文不会被 Buffer.concat 聚合。 */
async function* generateZip(files: ZipStreamFile[]): AsyncGenerator<Buffer> {
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    assertZip32(file.byteLength, "ZIP 单文件过大");
    const name = Buffer.from(file.path, "utf8");
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    // UTF-8 + Data Descriptor；CRC 与长度在正文结束后给出。
    localHeader.writeUInt16LE(0x0808, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(name.byteLength, 26);
    yield localHeader;
    yield name;

    let actualLength = 0;
    let crc = 0xffffffff;
    for await (const value of file.open()) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      actualLength += chunk.byteLength;
      if (actualLength > file.byteLength) throw new Error(`ZIP 文件长度超过声明值: ${file.path}`);
      crc = updateCrc32(crc, chunk);
      yield chunk;
    }
    if (actualLength !== file.byteLength) throw new Error(`ZIP 文件长度与声明值不一致: ${file.path}`);
    const finalCrc = (crc ^ 0xffffffff) >>> 0;
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(finalCrc, 4);
    descriptor.writeUInt32LE(actualLength, 8);
    descriptor.writeUInt32LE(actualLength, 12);
    yield descriptor;

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0808, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt32LE(finalCrc, 16);
    centralHeader.writeUInt32LE(actualLength, 20);
    centralHeader.writeUInt32LE(actualLength, 24);
    centralHeader.writeUInt16LE(name.byteLength, 28);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, name);
    offset += localHeader.byteLength + name.byteLength + actualLength + descriptor.byteLength;
    assertZip32(offset, "ZIP 总体过大");
  }
  const centralOffset = offset;
  for (const value of central) {
    offset += value.byteLength;
    yield value;
  }
  const centralLength = offset - centralOffset;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralLength, 12);
  end.writeUInt32LE(centralOffset, 16);
  yield end;
}

/** 在不读取正文的前提下计算无压缩 ZIP 的精确响应长度。 */
function zipStreamByteLength(files: ZipStreamFile[]): number {
  let total = 22;
  for (const file of files) {
    const nameLength = Buffer.byteLength(file.path, "utf8");
    total += 30 + nameLength + file.byteLength + 16 + 46 + nameLength;
    assertZip32(total, "ZIP 总体过大");
  }
  return total;
}

/** 当前实现是经典 ZIP32，超出边界时明确失败而不是写出截断长度。 */
function assertZip32(value: number, message: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw new Error(message);
}

/** 执行「crc32」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function crc32(bytes: Uint8Array): number {
  const crc = updateCrc32(0xffffffff, bytes);
  return (crc ^ 0xffffffff) >>> 0;
}

/** 支持跨流 chunk 延续 CRC32 中间状态。 */
function updateCrc32(initial: number, bytes: Uint8Array): number {
  let crc = initial;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return crc;
}
