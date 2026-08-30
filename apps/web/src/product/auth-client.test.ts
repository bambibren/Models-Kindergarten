import { afterEach, describe, expect, it, vi } from "vitest";
import { logout } from "./auth-client.js";

describe("logout client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("通过同源 POST 撤销当前登录会话", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await logout();

    expect(fetch).toHaveBeenCalledWith("/api/control/v1/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  });

  it("服务端拒绝退出时抛出错误", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    await expect(logout()).rejects.toThrow("退出登录失败（503）");
  });
});
