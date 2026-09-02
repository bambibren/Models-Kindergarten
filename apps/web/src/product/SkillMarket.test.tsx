import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SkillInstallation } from "@kindergarten/contracts";
import { SkillMarketReady } from "./SkillMarket.js";

const skills = [{
  name: "ui-design",
  url: "/skills/ui-design",
  displayName: "UI 设计与实现",
  description: "设计并实现可运行的网页和交互界面。",
  category: "设计与前端",
}];

describe("SkillMarketReady", () => {
  it("展示中文名称、介绍、资源名和两种闭环操作", () => {
    const html = renderToStaticMarkup(<SkillMarketReady installations={[]} skills={skills} />);
    expect(html).toContain("UI 设计与实现");
    expect(html).toContain("设计并实现可运行的网页和交互界面。");
    expect(html).toContain("ui-design");
    expect(html).toContain("复制地址");
    expect(html).toContain("安装到我的账号");
  });

  it("当前账号已拥有时禁用重复安装", () => {
    const installation = {
      schemaVersion: 1,
      skillInstallationId: "skill-1",
      ownerId: "user-1",
      skillName: "ui-design",
      state: "ready",
      source: { kind: "resource_bundle", url: "https://mk.example/skills/ui-design" },
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
    } satisfies SkillInstallation;
    const html = renderToStaticMarkup(<SkillMarketReady installations={[installation]} skills={skills} />);
    expect(html).toContain("已在我的 Skills");
    expect(html).toMatch(/<button disabled="" type="button">/u);
  });
});
