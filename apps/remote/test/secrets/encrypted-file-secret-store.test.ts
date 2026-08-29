import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EncryptedFileSecretStore } from "../../src/secrets/encrypted-file-secret-store.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("EncryptedFileSecretStore", () => {
  it("用 AES-GCM 写读删受管 Secret，磁盘从不包含明文", async () => {
    const { file, store } = await setup();
    const ref = { provider: "managed" as const, key: "models/connection-1" };

    await store.write(ref, "super-secret-value");
    expect(await readFile(file, "utf8")).not.toContain("super-secret-value");
    await expect(store.read(ref)).resolves.toBe("super-secret-value");
    await store.delete(ref);
    await store.delete(ref);
    await expect(store.read(ref)).rejects.toThrow("受管 Secret 不存在");
  });

  it("错误主密钥和被篡改认证标签都不能解密", async () => {
    const { file, store } = await setup();
    const ref = { provider: "managed" as const, key: "models/connection-1" };
    await store.write(ref, "secret");

    const wrong = new EncryptedFileSecretStore({ read: async () => Buffer.alloc(32, 2) }, file);
    await expect(wrong.read(ref)).rejects.toThrow("解密失败或凭据库已被篡改");
    await expect(wrong.delete(ref)).rejects.toThrow("解密失败或凭据库已被篡改");
    await expect(store.read(ref)).resolves.toBe("secret");

    const document = JSON.parse(await readFile(file, "utf8")) as { records: Record<string, { authTag: string }> };
    document.records[ref.key]!.authTag = Buffer.alloc(16, 3).toString("base64");
    await writeFile(file, `${JSON.stringify(document)}\n`, { mode: 0o600 });
    await expect(store.read(ref)).rejects.toThrow("解密失败或凭据库已被篡改");
  });

  it("串行化并发更新且 env Secret 保持只读", async () => {
    const { store } = await setup();
    await Promise.all(Array.from({ length: 16 }, (_, index) => store.write(
      { provider: "managed", key: `key-${index}` },
      `value-${index}`,
    )));
    await Promise.all(Array.from({ length: 16 }, async (_, index) => {
      await expect(store.read({ provider: "managed", key: `key-${index}` })).resolves.toBe(`value-${index}`);
    }));

    process.env.MK_TEST_ENV_SECRET = "from-env";
    await expect(store.read({ provider: "env", key: "MK_TEST_ENV_SECRET" })).resolves.toBe("from-env");
    await expect(store.write({ provider: "env", key: "MK_TEST_ENV_SECRET" }, "x")).rejects.toThrow("不能由应用写入");
    delete process.env.MK_TEST_ENV_SECRET;
  });

  it("无 Vault 时允许零模型启动，已有 Vault 缺少主密钥则拒绝就绪", async () => {
    const dir = await tempDir();
    const file = join(dir, "credentials.enc");
    const missingKey = new EncryptedFileSecretStore({ read: async () => { throw new Error("missing key"); } }, file);
    await expect(missingKey.initialize()).resolves.toBeUndefined();

    const working = new EncryptedFileSecretStore({ read: async () => Buffer.alloc(32, 1) }, file);
    await working.write({ provider: "managed", key: "key" }, "value");
    await expect(missingKey.initialize()).rejects.toThrow("missing key");
  });

  it("拒绝权限过宽或符号链接形式的 Vault", async () => {
    const { file, store } = await setup();
    await store.write({ provider: "managed", key: "key" }, "value");
    await chmod(file, 0o644);
    await expect(store.initialize()).rejects.toThrow("不能允许组或其他用户访问");

    const dir = await tempDir();
    const target = join(dir, "target.enc");
    const link = join(dir, "credentials.enc");
    await writeFile(target, "{}\n", { mode: 0o600 });
    await symlink(target, link);
    await expect(new EncryptedFileSecretStore(
      { read: async () => Buffer.alloc(32, 1) },
      link,
    ).initialize()).rejects.toThrow("普通文件");
  });
});

async function setup() {
  const dir = await tempDir();
  const file = join(dir, "secure", "credentials.enc");
  return {
    file,
    store: new EncryptedFileSecretStore({ read: async () => Buffer.alloc(32, 1) }, file),
  };
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mk-encrypted-secrets-"));
  dirs.push(dir);
  return dir;
}
