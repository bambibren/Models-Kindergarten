import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PasswordAuthStore } from "../../src/auth/password-auth-store.js";

let dir = "";

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

describe("PasswordAuthStore", () => {
  it("保存密码哈希并只接受正确密码", async () => {
    const store = await fixture();
    const user = await store.add("admin", "zhanglei234");
    expect(user).toMatchObject({ username: "admin", kind: "password_user" });
    expect(await store.verify("ADMIN", "zhanglei234")).toMatchObject({ principalId: user.principalId });
    expect(await store.verify("admin", "wrong-password")).toBeUndefined();
  });

  it("登录 Token 固定三十天过期且服务端不保存明文 Token", async () => {
    let now = new Date("2026-08-30T00:00:00.000Z");
    const store = await fixture(() => now);
    const user = await store.add("admin", "zhanglei234");
    const session = await store.createSession(user.principalId);
    expect(session.expiresAt).toBe("2026-09-29T00:00:00.000Z");
    expect(await store.resolveSession(session.token)).toMatchObject({ username: "admin" });
    now = new Date("2026-09-29T00:00:00.001Z");
    expect(await store.resolveSession(session.token)).toBeUndefined();
  });

  it("改密和禁用都会撤销旧会话，启用后可重新登录", async () => {
    const store = await fixture();
    const user = await store.add("admin", "zhanglei234");
    const first = await store.createSession(user.principalId);
    await store.resetPassword("admin", "new-password");
    expect(await store.resolveSession(first.token)).toBeUndefined();
    expect(await store.verify("admin", "new-password")).toBeDefined();
    const second = await store.createSession(user.principalId);
    await store.disable("admin");
    expect(await store.resolveSession(second.token)).toBeUndefined();
    expect(await store.verify("admin", "new-password")).toBeUndefined();
    await store.enable("admin");
    expect(await store.verify("admin", "new-password")).toBeDefined();
  });

  it("删除账号会撤销会话并删除登录记录", async () => {
    const store = await fixture();
    const user = await store.add("admin", "zhanglei234");
    const session = await store.createSession(user.principalId);
    await expect(store.remove("admin")).resolves.toEqual({ principalId: user.principalId });
    expect(await store.resolveSession(session.token)).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });
});

async function fixture(now?: () => Date): Promise<PasswordAuthStore> {
  dir = await mkdtemp(join(tmpdir(), "mk-auth-"));
  return new PasswordAuthStore(join(dir, "users.json"), join(dir, "sessions.json"), now);
}
