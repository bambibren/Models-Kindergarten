import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AuthGate } from "./AuthGate.js";

describe("登录状态验证入口", () => {
  it("验证期间只显示 Loading 图标，不显示可见文字", () => {
    const html = renderToStaticMarkup(<AuthGate><div>业务页面</div></AuthGate>);
    expect(html).toContain("loader-circular-ring");
    expect(html).toContain('aria-label="正在验证登录状态"');
    expect(html).not.toContain("<strong>正在验证登录状态</strong>");
  });
});
