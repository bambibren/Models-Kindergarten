# Account Logout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在所有真实产品页的顶部账号头像上提供 hover/focus 可见的退出按钮，点击后撤销当前登录 Cookie 并进入登录页。

**Architecture:** 复用 Remote 已有的 `POST /api/control/v1/auth/logout`，只修改 Web 产品导航和认证客户端。账号菜单由 `ProductNav` 统一渲染，CSS 同时支持鼠标 hover 与键盘 focus；退出请求成功后才跳转 `/login`，失败则留在当前页并允许重试。

**Tech Stack:** React 19、TypeScript、Vitest、现有同源 Control API、CSS

---

### Task 1: 固化退出请求合同

**Files:**
- Modify: `apps/web/src/product/auth-client.ts:30`
- Create: `apps/web/src/product/auth-client.test.ts`

- [x] **Step 1: 写出失败测试**

```ts
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
```

- [x] **Step 2: 运行测试并确认失败**

Run: `pnpm --filter @kindergarten/web test -- src/product/auth-client.test.ts`

Expected: 第二个用例失败，因为现有 `logout()` 未检查非 2xx 响应。

- [x] **Step 3: 让退出客户端显式暴露失败**

```ts
export async function logout(): Promise<void> {
  const response = await fetch("/api/control/v1/auth/logout", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!response.ok) throw new Error(`退出登录失败（${response.status}）`);
}
```

- [x] **Step 4: 运行退出客户端测试**

Run: `pnpm --filter @kindergarten/web test -- src/product/auth-client.test.ts`

Expected: 2 tests passed。

### Task 2: 给账号头像增加 hover 退出菜单

**Files:**
- Modify: `apps/web/src/product/ProductNav.tsx:1-14`
- Modify: `apps/web/src/product/product.css:7-12`
- Create: `apps/web/src/product/ProductNav.test.tsx`

- [x] **Step 1: 写出账号菜单与退出流程测试**

```tsx
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
```

- [x] **Step 2: 运行测试并确认失败**

Run: `pnpm --filter @kindergarten/web test -- src/product/ProductNav.test.tsx`

Expected: FAIL，因为 `performLogout` 与账号退出按钮尚不存在。

- [x] **Step 3: 在 ProductNav 实现退出状态和账号菜单**

```tsx
import { useState } from "react";
import { Bot, GraduationCap, LogOut, UserRound } from "lucide-react";
import { logout } from "./auth-client.js";

export async function performLogout(
  request: () => Promise<void> = logout,
  navigate: (path: string) => void = (path) => location.assign(path),
): Promise<void> {
  await request();
  navigate("/login");
}

/** 渲染「ProductNav」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function ProductNav({ active }: { active: "home" | "context" | "me" | "chat" | "agent" }) {
  const [logoutState, setLogoutState] = useState<"idle" | "pending" | "failed">("idle");
  const onLogout = async () => {
    if (logoutState === "pending") return;
    setLogoutState("pending");
    try { await performLogout(); }
    catch { setLogoutState("failed"); }
  };

  return <header className="product-nav">
    <a className="product-brand" href="/"><span><GraduationCap size={17} /></span><div><strong>模型幼儿园</strong><small>Models KinderGarten</small></div></a>
    <nav>
      {/* 上下文实验保留实现；功能调研期间不暴露顶部导航入口。 */}
      <a className={active === "agent" ? "active" : ""} href="/agents/new"><Bot size={14} />新建 Agent</a>
      <div className="product-account">
        <a aria-label="打开个人空间" className={`product-account-trigger ${active === "me" ? "active" : ""}`} href="/me"><UserRound size={14} /><span>Admin</span></a>
        <div className="product-account-menu">
          <button aria-label="退出登录" disabled={logoutState === "pending"} type="button" onClick={() => void onLogout()}><LogOut size={14} />{logoutState === "pending" ? "正在退出" : logoutState === "failed" ? "退出失败，请重试" : "退出登录"}</button>
        </div>
      </div>
    </nav>
  </header>;
}
```

- [x] **Step 4: 增加 hover、focus 与菜单视觉样式**

```css
.product-nav nav { display: flex; align-items: center; gap: 4px; }
.product-nav nav a { display: flex; align-items: center; gap: 6px; padding: 7px 9px; border-radius: 8px; color: #777971; font-size: 12px; }
.product-nav nav a:hover, .product-nav nav a.active { color: #30312e; background: #ecece8; }
.product-account { position: relative; }
.product-account-menu { position: absolute; z-index: 30; top: 100%; right: 0; min-width: 142px; padding-top: 7px; opacity: 0; visibility: hidden; transform: translateY(-4px); transition: opacity 120ms ease, transform 120ms ease, visibility 120ms; pointer-events: none; }
.product-account:hover .product-account-menu, .product-account:focus-within .product-account-menu { opacity: 1; visibility: visible; transform: translateY(0); pointer-events: auto; }
.product-account-menu button { display: flex; align-items: center; gap: 7px; width: 100%; padding: 9px 10px; border: 1px solid #ddddda; border-radius: 9px; color: #555750; background: #fff; box-shadow: 0 12px 34px rgb(25 26 23 / .14); font-size: 10px; white-space: nowrap; cursor: pointer; }
.product-account-menu button:hover:not(:disabled), .product-account-menu button:focus-visible { color: #8c4f49; background: #f7f1ef; }
.product-account-menu button:disabled { opacity: .65; cursor: wait; }
```

- [x] **Step 5: 运行组件测试**

Run: `pnpm --filter @kindergarten/web test -- src/product/ProductNav.test.tsx`

Expected: 3 tests passed。

### Task 3: 完整 Web 验证

**Files:**
- Verify only: `apps/web/src/product/ProductNav.tsx`
- Verify only: `apps/web/src/product/product.css`

- [x] **Step 1: 运行 Web 全量测试、类型检查和构建**

Run: `pnpm --filter @kindergarten/web test && pnpm --filter @kindergarten/web typecheck && pnpm --filter @kindergarten/web build`

Expected: 全部命令退出码为 0。

- [x] **Step 2: 浏览器验收真实交互**

Run: `pnpm dev`

Expected: 登录后，将鼠标移到顶部 `Admin` 头像区域会出现“退出登录”；键盘聚焦该区域也能显示菜单；点击后调用退出接口并进入 `/login`；接口失败时保留当前页并把按钮文案变为“退出失败，请重试”。
