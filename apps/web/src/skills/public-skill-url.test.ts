import { describe, expect, it } from "vitest";
import { publicSkillUrl } from "./public-skill-url.js";

describe("publicSkillUrl", () => {
  it("在开发、预演和生产环境保持相同路径", () => {
    expect(publicSkillUrl("pptx", "http://127.0.0.1:5173")).toBe("http://127.0.0.1:5173/skills/pptx");
    expect(publicSkillUrl("pptx", "https://mk.localhost")).toBe("https://mk.localhost/skills/pptx");
    expect(publicSkillUrl("website-design-fast", "https://mk.example.com")).toBe("https://mk.example.com/skills/website-design-fast");
  });

  it("拒绝路径和非法 Skill 名称", () => {
    expect(() => publicSkillUrl("../pptx", "https://mk.example.com")).toThrow("Skill 名称无效");
    expect(() => publicSkillUrl("pptx", "https://mk.example.com/base")).toThrow("公开源站必须");
  });
});
