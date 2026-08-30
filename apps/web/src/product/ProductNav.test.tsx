import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { performLogout, ProductNav } from "./ProductNav.js";
import { AuthSessionProvider } from "./auth-session-context.js";

const passwordSession = {
  authenticated: true as const,
  principal: { principalId: "user-1", username: "bengzakalaka", kind: "password_user" as const },
};

describe("product account menu", () => {
  it("在头像账号区域提供可访问的退出按钮", () => {
    const html = renderToStaticMarkup(<AuthSessionProvider session={passwordSession}><ProductNav active="home" /></AuthSessionProvider>);
    expect(html).toContain("product-account");
    expect(html).toContain("bengzakalaka");
    expect(html).not.toContain(">Admin<");
    expect(html).toContain('aria-label="打开 bengzakalaka 的个人空间"');
    expect(html).toContain('aria-label="退出登录"');
    expect(html).toContain("退出登录");
  });

  it("退出成功后进入登录页", async () => {
    const request = vi.fn().mockResolvedValue(undefined);
    const navigate = vi.fn();
    await performLogout(request, navigate);
    expect(request).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith("/login");
  });

  it("退出失败时不离开当前页面", async () => {
    const navigate = vi.fn();
    await expect(performLogout(vi.fn().mockRejectedValue(new Error("offline")), navigate)).rejects.toThrow("offline");
    expect(navigate).not.toHaveBeenCalled();
  });
});
