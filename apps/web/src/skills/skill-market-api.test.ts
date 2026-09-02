import { describe, expect, it, vi } from "vitest";
import { filterSkillMarket, readSkillMarket, type SkillMarketEntry } from "./skill-market-api.js";

const entries: SkillMarketEntry[] = [
  { name: "pptx", url: "/skills/pptx", displayName: "PPT 演示文稿", description: "创建演示文稿。", category: "文档与数据" },
  { name: "ui-design", url: "/skills/ui-design", displayName: "UI 设计与实现", description: "设计网页界面。", category: "设计与前端" },
];

describe("Skill 市场目录", () => {
  it("读取同源中文目录并保留资源顺序", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ schemaVersion: 1, skills: entries }), { status: 200 }));
    await expect(readSkillMarket(fetchImpl)).resolves.toEqual(entries);
    expect(fetchImpl).toHaveBeenCalledWith("/skills", { credentials: "same-origin" });
  });

  it("拒绝缺少中文介绍的旧目录", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: 1,
      skills: [{ name: "pptx", url: "/skills/pptx" }],
    }), { status: 200 }));
    await expect(readSkillMarket(fetchImpl)).rejects.toThrow("目录结构无效");
  });

  it("同时支持中文、资源名与分类筛选", () => {
    expect(filterSkillMarket(entries, "演示", "全部").map((item) => item.name)).toEqual(["pptx"]);
    expect(filterSkillMarket(entries, "ui-design", "全部").map((item) => item.name)).toEqual(["ui-design"]);
    expect(filterSkillMarket(entries, "", "设计与前端").map((item) => item.name)).toEqual(["ui-design"]);
  });
});
