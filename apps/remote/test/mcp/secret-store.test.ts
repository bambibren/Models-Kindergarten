import { describe, expect, it } from "vitest";
import { HostSecretStore } from "../../src/mcp/secret-store.js";

describe("HostSecretStore writable Keychain boundary", () => {
  it("使用固定 account 写、读、删 keychain 项", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const store = new HostSecretStore(async (file, args) => {
      calls.push({ file, args });
      return { stdout: args[0] === "find-generic-password" ? "secret-value\n" : "" };
    }, "darwin");
    const ref = { provider: "keychain" as const, key: "models-kindergarten/test" };

    await store.write(ref, "secret-value");
    await expect(store.read(ref)).resolves.toBe("secret-value");
    await store.delete(ref);

    expect(calls.map((item) => item.args[0])).toEqual([
      "add-generic-password",
      "find-generic-password",
      "delete-generic-password",
    ]);
    expect(calls.every((item) => item.args.includes("local-admin"))).toBe(true);
  });

  it("底层写入异常不会把 argv 中的明文 Secret 带到公开错误", async () => {
    const store = new HostSecretStore(async () => { throw new Error("cmd contained super-secret"); }, "darwin");
    await expect(store.write(
      { provider: "keychain", key: "models-kindergarten/test" },
      "super-secret",
    )).rejects.toThrow("无法写入 macOS Keychain");
    await expect(store.write(
      { provider: "keychain", key: "models-kindergarten/test" },
      "super-secret",
    )).rejects.not.toThrow("super-secret");
  });

  it("非 macOS 和 env 写操作均被拒绝", async () => {
    const store = new HostSecretStore(async () => ({ stdout: "" }), "linux");
    await expect(store.write({ provider: "keychain", key: "x" }, "y")).rejects.toThrow("只支持 macOS");
    await expect(store.write({ provider: "env", key: "X" }, "y")).rejects.toThrow("不能由应用写入");
  });

  it("删除只把 Keychain not-found 视为幂等成功", async () => {
    const missing = new HostSecretStore(async () => { throw Object.assign(new Error("missing"), { code: 44 }); }, "darwin");
    await expect(missing.delete({ provider: "keychain", key: "x" })).resolves.toBeUndefined();
    const broken = new HostSecretStore(async () => { throw new Error("locked"); }, "darwin");
    await expect(broken.delete({ provider: "keychain", key: "x" })).rejects.toThrow("无法从 macOS Keychain 删除");
  });
});
