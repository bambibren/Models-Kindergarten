import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { safeNextPath } from "./auth-client.js";
import { LoginPage } from "./LoginPage.js";

describe("login page", () => {
  it("只提供用户名密码登录，不提供注册入口", () => {
    const html = renderToStaticMarkup(<LoginPage />);
    expect(html).toContain("登录模型幼儿园");
    expect(html).toContain("用户名");
    expect(html).toContain("密码");
    expect(html).toContain("不提供在线注册");
    expect(html).not.toContain("注册账号");
  });

  it("登录后只允许跳回站内路径", () => {
    expect(safeNextPath("?next=%2Fmodels%2Fnew")).toBe("/models/new");
    expect(safeNextPath("?next=https%3A%2F%2Fevil.example")).toBe("/");
    expect(safeNextPath("?next=%2F%2Fevil.example")).toBe("/");
  });
});
