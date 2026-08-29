import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EncryptedFileSecretStore } from "../../src/secrets/encrypted-file-secret-store.js";
import { LegacyMacKeychainReader } from "../../src/secrets/legacy-keychain-reader.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("旧 Keychain 一次性迁移", () => {
  it("Vault 缺记录时迁移后删除旧项，后续读取不再访问 Keychain", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mk-keychain-migration-"));
    dirs.push(dir);
    const file = join(dir, "credentials.enc");
    const legacy = {
      read: vi.fn(async () => "legacy-secret" as string | undefined),
      delete: vi.fn(async () => undefined),
    };
    const store = new EncryptedFileSecretStore({ read: async () => Buffer.alloc(32, 8) }, file, legacy);
    const ref = { provider: "managed" as const, key: "models/legacy" };

    await expect(store.read(ref)).resolves.toBe("legacy-secret");
    await expect(store.read(ref)).resolves.toBe("legacy-secret");
    expect(legacy.read).toHaveBeenCalledTimes(1);
    expect(legacy.delete).toHaveBeenCalledTimes(1);
    expect(await readFile(file, "utf8")).not.toContain("legacy-secret");
  });

  it("非 macOS 不调用 security，macOS 只使用固定 account", async () => {
    const execute = vi.fn(async (_file: string, _args: string[]) => ({ stdout: "secret\n" }));
    const linux = new LegacyMacKeychainReader(execute, "linux");
    await expect(linux.read("key")).resolves.toBeUndefined();
    expect(execute).not.toHaveBeenCalled();

    const mac = new LegacyMacKeychainReader(execute, "darwin");
    await expect(mac.read("models/key")).resolves.toBe("secret");
    await mac.delete("models/key");
    expect(execute.mock.calls.map((call) => call[1]?.[0])).toEqual([
      "find-generic-password",
      "delete-generic-password",
    ]);
    expect(execute.mock.calls.every((call) => call[1]?.includes("local-admin"))).toBe(true);
  });
});
