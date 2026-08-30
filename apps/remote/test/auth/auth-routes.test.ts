import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AUTH_PUBLIC_PATHS, registerAuthRoutes } from "../../src/auth/auth-routes.js";
import { AuthService } from "../../src/auth/auth-service.js";
import { PasswordAuthStore } from "../../src/auth/password-auth-store.js";
import { ControlApi } from "../../src/server/control-api.js";

let dir = "";

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

describe("password auth routes", () => {
  it("未登录拒绝业务 API，登录后设置安全 Cookie 并恢复身份", async () => {
    const { api } = await fixture();
    expect((await api.fetch(request("GET", "/private")))?.status).toBe(401);

    const login = await api.fetch(request("POST", "/auth/login", {
      username: "admin",
      password: "zhanglei234",
    }));
    expect(login?.status).toBe(200);
    const setCookie = login?.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("mk_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Max-Age=2592000");

    const cookie = setCookie.split(";", 1)[0];
    const session = await api.fetch(request("GET", "/auth/session", undefined, cookie));
    expect(session?.status).toBe(200);
    expect(await session?.json()).toMatchObject({ data: { principal: { username: "admin" } } });
    expect((await api.fetch(request("GET", "/private", undefined, cookie)))?.status).toBe(200);
  });

  it("错误密码统一返回用户名或密码错误", async () => {
    const { api } = await fixture();
    const response = await api.fetch(request("POST", "/auth/login", {
      username: "missing",
      password: "wrong-password",
    }));
    expect(response?.status).toBe(401);
    expect(await response?.json()).toMatchObject({ detail: "用户名或密码错误" });
  });

  it("退出后撤销当前 Cookie", async () => {
    const { api } = await fixture();
    const login = await api.fetch(request("POST", "/auth/login", { username: "admin", password: "zhanglei234" }));
    const cookie = (login?.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const logout = await api.fetch(request("POST", "/auth/logout", {}, cookie));
    expect(logout?.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await api.fetch(request("GET", "/private", undefined, cookie)))?.status).toBe(401);
  });
});

async function fixture() {
  dir = await mkdtemp(join(tmpdir(), "mk-auth-routes-"));
  const store = new PasswordAuthStore(join(dir, "users.json"), join(dir, "sessions.json"));
  await store.add("admin", "zhanglei234");
  const auth = new AuthService("required", store);
  const api = new ControlApi({
    allowedOrigins: ["https://mk.example.com"],
    resolvePrincipal: (value) => auth.resolve(value),
    publicPaths: AUTH_PUBLIC_PATHS,
  });
  registerAuthRoutes(api.router, auth);
  api.router.register("GET", "/private", ({ principal }) => ({ principalId: principal.principalId }));
  return { api, store };
}

function request(method: string, path: string, body?: unknown, cookie?: string): Request {
  return new Request(`https://mk.example.com/api/control/v1${path}`, {
    method,
    headers: {
      ...(method === "POST" ? { origin: "https://mk.example.com", "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
