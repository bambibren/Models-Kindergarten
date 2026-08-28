import { describe, expect, it } from "vitest";
import { HostSecretStore } from "../../src/mcp/secret-store.js";

describe("HostSecretStore writable Keychain boundary", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("使用固定 account 写、读、删 keychain 项", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const store = new HostSecretStore(/** 构造「store」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async (file, args) => {
      calls.push({ file, args });
      return { stdout: args[0] === "find-generic-password" ? "secret-value\n" : "" };
    }, "darwin");
    const ref = { provider: "keychain" as const, key: "models-kindergarten/test" };

    await store.write(ref, "secret-value");
    await expect(store.read(ref)).resolves.toBe("secret-value");
    await store.delete(ref);

    expect(calls.map(/** 构造「toEqual」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(item) => item.args[0])).toEqual([
      "add-generic-password",
      "find-generic-password",
      "delete-generic-password",
    ]);
    expect(calls.every(/** 构造「toBe」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(item) => item.args.includes("local-admin"))).toBe(true);
  });

  it("底层写入异常不会把 argv 中的明文 Secret 带到公开错误", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const store = new HostSecretStore(/** 构造「store」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => { throw new Error("cmd contained super-secret"); }, "darwin");
    await expect(store.write(
      { provider: "keychain", key: "models-kindergarten/test" },
      "super-secret",
    )).rejects.toThrow("无法写入 macOS Keychain");
    await expect(store.write(
      { provider: "keychain", key: "models-kindergarten/test" },
      "super-secret",
    )).rejects.not.toThrow("super-secret");
  });

  it("非 macOS 和 env 写操作均被拒绝", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const store = new HostSecretStore(/** 构造「store」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => ({ stdout: "" }), "linux");
    await expect(store.write({ provider: "keychain", key: "x" }, "y")).rejects.toThrow("只支持 macOS");
    await expect(store.write({ provider: "env", key: "X" }, "y")).rejects.toThrow("不能由应用写入");
  });

  it("删除只把 Keychain not-found 视为幂等成功", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const missing = new HostSecretStore(/** 构造「missing」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => { throw Object.assign(new Error("missing"), { code: 44 }); }, "darwin");
    await expect(missing.delete({ provider: "keychain", key: "x" })).resolves.toBeUndefined();
    const broken = new HostSecretStore(/** 构造「broken」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => { throw new Error("locked"); }, "darwin");
    await expect(broken.delete({ provider: "keychain", key: "x" })).rejects.toThrow("无法从 macOS Keychain 删除");
  });
});
