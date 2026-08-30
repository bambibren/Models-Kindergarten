import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SkillLockStore } from "../../src/skills/skill-lock-store.js";
import { SkillRegistry } from "../../src/skills/skill-registry.js";

const dirs: string[] = [];

afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("SkillRegistry Builtin Skill", () => {
  it("用固定 builtin:<name> 引用向所有账号暴露镜像内 Skill", async () => {
    const root = await mkdtemp(join(tmpdir(), "mk-builtin-registry-"));
    dirs.push(root);
    const skillDir = join(root, "sandbox-notes");
    await mkdir(skillDir);
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: sandbox-notes\ndescription: 记录沙箱笔记\n---\n\n记录任务笔记。\n");
    const registry = new SkillRegistry([{
      path: root,
      scope: "builtin",
      trust: "builtin",
      source: "builtin",
    }], new SkillLockStore(join(root, "lock.json")));

    await registry.initialize();

    expect(registry.builtinOptions()).toEqual([{
      skillId: "builtin:sandbox-notes",
      name: "sandbox-notes",
      description: "记录沙箱笔记",
    }]);
    expect(registry.builtinNames(["builtin:sandbox-notes"])).toEqual(["sandbox-notes"]);
    expect(() => registry.builtinNames(["builtin:missing"])).toThrow("Builtin Skill 不存在");
    expect(() => registry.builtinNames(["installation:legacy"])).toThrow("Builtin Skill ID 无效");
  });
});
