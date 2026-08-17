import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRODUCT_CONFIG } from "@kindergarten/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { validateSkillDirectory } from "../../src/skills/skill-validator.js";

const dirs: string[] = [];

afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("Skill directory validation", () => {
  it("只保留目录安全、总大小和文件数限制，不修改 Skill 自身格式", async () => {
    const root = await skillRoot("folder-name", `${"Custom ".repeat(10)}Skill`, "d".repeat(1_100));
    await mkdir(join(root, "bin"), { recursive: true });
    await writeFile(join(root, ".notes"), "hidden file is valid skill content");
    await writeFile(join(root, "large-resource.bin"), Buffer.alloc(300 * 1024, 1));
    await writeFile(join(root, "bin", "run"), "#!/bin/sh\necho ok\n");
    await chmod(join(root, "bin", "run"), 0o755);

    const skill = await validateSkillDirectory(root, base());

    expect(skill.name).toBe(`${"Custom ".repeat(10)}Skill`);
    expect(skill.description).toBe("d".repeat(1_100));
  });

  it("仍按统一配置拒绝文件数超限", async () => {
    const root = await skillRoot("too-many-files", "many-files", "test");
    await Promise.all(Array.from({ length: PRODUCT_CONFIG.skill.maxFiles }, (_, index) =>
      writeFile(join(root, `file-${index}.txt`), String(index))));

    await expect(validateSkillDirectory(root, base()))
      .rejects.toThrow(`Skill 文件数量超过 ${PRODUCT_CONFIG.skill.maxFiles}`);
  });

  it("仍按统一配置拒绝总大小超限", async () => {
    const root = await skillRoot("too-large", "large-skill", "test");
    await writeFile(join(root, "payload.bin"), Buffer.alloc(PRODUCT_CONFIG.skill.maxTotalBytes, 1));

    await expect(validateSkillDirectory(root, base()))
      .rejects.toThrow(`Skill 总大小超过 ${PRODUCT_CONFIG.skill.maxTotalBytes} 字节`);
  });
});

async function skillRoot(directoryName: string, name: string, description: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "mk-skill-validator-"));
  dirs.push(parent);
  const root = join(parent, directoryName);
  await mkdir(root);
  await writeFile(join(root, "SKILL.md"), `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\nDo the work.\n`);
  return root;
}

function base() {
  return {
    source: { kind: "user" as const, path: "/tmp/source" },
    scope: "user" as const,
    installedAt: Date.now(),
    trust: "approved" as const,
  };
}
