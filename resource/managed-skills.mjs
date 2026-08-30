import { readFile } from "node:fs/promises";

/** 读取 Web 镜像允许发布的受管 Skill 清单；清单本身必须稳定、无重复且已排序。 */
export async function readManagedSkillNames(file) {
  const value = JSON.parse(await readFile(file, "utf8"));
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.skills)) {
    throw new Error("受管 Skill 清单结构无效");
  }
  const names = value.skills;
  if (names.some((name) => typeof name !== "string" || !/^[a-z0-9-]+$/u.test(name))) {
    throw new Error("受管 Skill 名称必须使用小写字母、数字和连字符");
  }
  if (new Set(names).size !== names.length) throw new Error("受管 Skill 清单包含重复名称");
  const sorted = names.toSorted((left, right) => left.localeCompare(right));
  if (JSON.stringify(names) !== JSON.stringify(sorted)) throw new Error("受管 Skill 清单必须按名称排序");
  return names;
}

/** 要求实际发布集合与受管清单完全一致，既不能漏发，也不能夹带未审核目录。 */
export function assertManagedSkillNames(actual, expected, label = "受管 Skill") {
  const normalized = actual.toSorted((left, right) => left.localeCompare(right));
  if (JSON.stringify(normalized) !== JSON.stringify(expected)) {
    throw new Error(`${label} 集合不匹配：期望 ${expected.join(", ")}；实际 ${normalized.join(", ") || "空"}`);
  }
}

/** 验证镜像中的静态 Bundle 仍保留名称和必需入口，避免只有列表没有可安装内容。 */
export function assertManagedSkillBundle(value, name) {
  if (!value || value.schemaVersion !== 1 || value.kind !== "mk-skill-bundle" || value.name !== name || !Array.isArray(value.files)) {
    throw new Error(`Skill ${name} 的静态 Bundle 结构无效`);
  }
  if (!value.files.some((file) => file?.path === "SKILL.md" && typeof file.content === "string")) {
    throw new Error(`Skill ${name} 的静态 Bundle 缺少 SKILL.md`);
  }
}
