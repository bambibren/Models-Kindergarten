import { resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { exportStaticResourceSite } from "./server.mjs";

const outputRoot = resolve(process.argv[2] ?? "dist-static");
const resourceRoot = dirname(fileURLToPath(import.meta.url));
const skillsRoot = resolve(process.env.MK_RESOURCE_SKILLS_DIR ?? resolve(resourceRoot, "skills"));
const skills = await exportStaticResourceSite(skillsRoot, outputRoot);
console.log(`已导出 ${skills.length} 个 Skill 静态资源到 ${outputRoot}`);
