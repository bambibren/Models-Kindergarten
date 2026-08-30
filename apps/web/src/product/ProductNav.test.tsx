import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { performLogout, ProductNav } from "./ProductNav.js";

describe("product account menu", () => {
  it("在头像账号区域提供可访问的退出按钮", () => {
    const html = renderToStaticMarkup(<ProductNav active="home" />);
    expect(html).toContain("product-account");
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
