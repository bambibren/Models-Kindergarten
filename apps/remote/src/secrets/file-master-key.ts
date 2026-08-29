import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const MASTER_KEY_BYTES = 32;
const BASE64_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/u;

/** 从普通文件读取 Vault 主密钥；文件位置由 deployment profile 决定。 */
export class FileMasterKeySource {
  constructor(readonly file: string) {}

  async read(): Promise<Buffer> {
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try { metadata = await lstat(this.file); }
    catch (error) {
      if (isMissing(error)) throw new Error(`主密钥文件不存在，请先运行 pnpm secret:init: ${this.file}`);
      throw new Error(`无法读取主密钥文件元数据: ${this.file}`);
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("主密钥必须是普通文件，不能是目录或符号链接");
    }
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new Error("主密钥文件只能由运行 MK 的系统账号读取（0400 或 0600），不能允许组或其他用户访问");
    }
    const encoded = (await readFile(this.file, "utf8")).trim();
    if (!BASE64_KEY_PATTERN.test(encoded)) throw new Error("主密钥必须是 32 字节 base64");
    const value = Buffer.from(encoded, "base64");
    if (value.byteLength !== MASTER_KEY_BYTES || value.toString("base64") !== encoded) {
      throw new Error("主密钥必须是 32 字节 base64");
    }
    return value;
  }
}

/** 创建本地或容器主密钥；使用 wx 保证任何已有文件都不会被覆盖。 */
export async function initializeMasterKey(
  file: string,
  generate: () => Buffer = () => randomBytes(MASTER_KEY_BYTES),
): Promise<void> {
  const key = generate();
  if (key.byteLength !== MASTER_KEY_BYTES) throw new Error("主密钥生成器必须返回 32 字节");
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  try {
    await writeFile(file, `${key.toString("base64")}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (isExists(error)) throw new Error(`主密钥文件已存在，拒绝覆盖: ${file}`);
    throw new Error(`无法创建主密钥文件: ${file}`);
  } finally {
    key.fill(0);
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
