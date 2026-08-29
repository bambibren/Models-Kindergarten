import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SecretRef } from "../mcp/mcp-types.js";
import type { WritableSecretStore } from "../mcp/secret-store.js";
import type { FileMasterKeySource } from "./file-master-key.js";
import type { LegacySecretSource } from "./legacy-keychain-reader.js";

interface EncryptedSecretRecord {
  iv: string;
  ciphertext: string;
  authTag: string;
  updatedAt: string;
}

interface CredentialVaultDocument {
  version: 1;
  algorithm: "aes-256-gcm";
  records: Record<string, EncryptedSecretRecord>;
}

const EMPTY_VAULT: CredentialVaultDocument = { version: 1, algorithm: "aes-256-gcm", records: {} };

/** 同一加密凭据库服务本机源码与容器；环境差异只存在于主密钥文件路径。 */
export class EncryptedFileSecretStore implements WritableSecretStore {
  private mutations: Promise<void> = Promise.resolve();

  constructor(
    private readonly masterKey: Pick<FileMasterKeySource, "read">,
    readonly file: string,
    private readonly legacy?: LegacySecretSource,
  ) {}

  /** 已有 Vault 必须在监听端口前验证主密钥和全部认证标签；空系统不强制先创建密钥。 */
  async initialize(): Promise<void> {
    const document = await this.load();
    if (!document) return;
    const key = await this.readMasterKey();
    try {
      for (const [recordKey, record] of Object.entries(document.records)) {
        decryptRecord(recordKey, record, key).fill(0);
      }
    } finally {
      key.fill(0);
    }
  }

  async read(ref: SecretRef): Promise<string> {
    if (ref.provider === "env") {
      const value = process.env[ref.key];
      if (!value) throw new Error(`环境 Secret 不存在: ${ref.key}`);
      return value;
    }
    await this.mutations;
    const document = await this.load();
    const record = document?.records[ref.key];
    if (record) return await this.decrypt(ref.key, record);

    const migrated = await this.legacy?.read(ref.key);
    if (migrated !== undefined) {
      await this.write({ provider: "managed", key: ref.key }, migrated);
      try { await this.legacy?.delete(ref.key); }
      catch { /* Vault 已完成原子写入；旧副本清理失败不能让正式凭据重新丢失。 */ }
      return migrated;
    }
    throw new Error(`受管 Secret 不存在: ${ref.key}`);
  }

  async write(ref: SecretRef, value: string): Promise<void> {
    if (ref.provider === "env") throw new Error("环境 Secret 不能由应用写入");
    if (!value) throw new Error("Secret 不能为空");
    await this.enqueue(async () => {
      const document = (await this.load()) ?? structuredClone(EMPTY_VAULT);
      const key = await this.readMasterKey();
      try {
        document.records[ref.key] = encryptRecord(ref.key, value, key);
        await this.save(document);
      } finally {
        key.fill(0);
      }
    });
  }

  async delete(ref: SecretRef): Promise<void> {
    if (ref.provider === "env") throw new Error("环境 Secret 不能由应用删除");
    await this.enqueue(async () => {
      const document = await this.load();
      const record = document?.records[ref.key];
      if (!document || !record) {
        try { await this.legacy?.delete(ref.key); } catch { /* 幂等删除不因旧存储不可用而失败。 */ }
        return;
      }
      const key = await this.readMasterKey();
      try {
        // 删除前也验证目标记录，避免主密钥在运行期间被替换后静默改写 Vault。
        decryptRecord(ref.key, record, key).fill(0);
      } finally {
        key.fill(0);
      }
      delete document.records[ref.key];
      await this.save(document);
      try { await this.legacy?.delete(ref.key); } catch { /* 正式 Vault 已删除，旧清理仅是升级卫生。 */ }
    });
  }

  private async decrypt(recordKey: string, record: EncryptedSecretRecord): Promise<string> {
    const key = await this.readMasterKey();
    let clear: Buffer | undefined;
    try {
      clear = decryptRecord(recordKey, record, key);
      return clear.toString("utf8");
    } finally {
      clear?.fill(0);
      key.fill(0);
    }
  }

  private async readMasterKey(): Promise<Buffer> {
    const key = Buffer.from(await this.masterKey.read());
    if (key.byteLength !== 32) {
      key.fill(0);
      throw new Error("Vault 主密钥必须是 32 字节");
    }
    return key;
  }

  private async load(): Promise<CredentialVaultDocument | undefined> {
    let value: unknown;
    try {
      const stat = await lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Vault 必须是普通文件");
      if ((stat.mode & 0o077) !== 0) throw new Error("Vault 不能允许组或其他用户访问");
      value = JSON.parse(await readFile(this.file, "utf8")) as unknown;
    }
    catch (error) {
      if (isMissing(error)) return undefined;
      const reason = error instanceof Error ? `: ${error.message}` : "";
      throw new Error(`无法读取加密凭据库: ${this.file}${reason}`);
    }
    return parseVault(value);
  }

  private async save(document: CredentialVaultDocument): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temp, this.file);
    } finally {
      try { await unlink(temp); } catch (error) { if (!isMissing(error)) throw error; }
    }
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(operation, operation);
    this.mutations = result.then(() => undefined, () => undefined);
    return result;
  }
}

function encryptRecord(recordKey: string, value: string, key: Buffer): EncryptedSecretRecord {
  const iv = randomBytes(12);
  const clear = Buffer.from(value, "utf8");
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(recordKey, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(clear), cipher.final()]);
    return {
      iv: iv.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      updatedAt: new Date().toISOString(),
    };
  } finally {
    clear.fill(0);
    iv.fill(0);
  }
}

function decryptRecord(recordKey: string, record: EncryptedSecretRecord, key: Buffer): Buffer {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64"));
    decipher.setAAD(Buffer.from(recordKey, "utf8"));
    decipher.setAuthTag(Buffer.from(record.authTag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, "base64")),
      decipher.final(),
    ]);
  } catch {
    throw new Error("Secret 解密失败或凭据库已被篡改");
  }
}

function parseVault(value: unknown): CredentialVaultDocument {
  if (!isRecord(value) || value.version !== 1 || value.algorithm !== "aes-256-gcm" || !isRecord(value.records)) {
    throw new Error("加密凭据库格式无效");
  }
  const records: Record<string, EncryptedSecretRecord> = {};
  for (const [key, item] of Object.entries(value.records)) {
    if (!isRecord(item)) {
      throw new Error(`加密凭据记录格式无效: ${key}`);
    }
    records[key] = {
      iv: requiredString(item.iv, key),
      ciphertext: requiredString(item.ciphertext, key),
      authTag: requiredString(item.authTag, key),
      updatedAt: requiredString(item.updatedAt, key),
    };
  }
  return { version: 1, algorithm: "aes-256-gcm", records };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, key: string): string {
  if (typeof value !== "string") throw new Error(`加密凭据记录格式无效: ${key}`);
  return value;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
