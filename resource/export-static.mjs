import { resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { exportStaticResourceSite } from "./server.mjs";
import { assertManagedSkillNames, readManagedSkillNames } from "./managed-skills.mjs";

const outputRoot = resolve(process.argv[2] ?? "dist-static");
const resourceRoot = dirname(fileURLToPath(import.meta.url));
const skillsRoot = resolve(process.env.MK_RESOURCE_SKILLS_DIR ?? resolve(resourceRoot, "skills"));
const skills = await exportStaticResourceSite(skillsRoot, outputRoot);
if (process.env.MK_REQUIRED_SKILLS_FILE) {
  const expected = await readManagedSkillNames(resolve(process.env.MK_REQUIRED_SKILLS_FILE));
  assertManagedSkillNames(skills, expected, "导出的受管 Skill");
}
console.log(`已导出 ${skills.length} 个 Skill 静态资源到 ${outputRoot}`);
