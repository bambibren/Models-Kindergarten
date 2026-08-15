export const DEFAULT_SKILL_CONTEXT_VERSION = "v1" as const;

const SKILL_USE_PROTOCOLS = {
  v1: [
    "【Skill 使用协议】",
    "- Skill 是按需加载的任务执行说明。",
    "- <available_skills> 只包含当前 Agent 可用 Skill 的元数据；目录可见不代表完整指令已经加载。",
    "- 用户明确指定 Skill，或任务语义与 description 匹配时，在执行相关任务前调用 activate_skill。",
    "- activate_skill 只加载一个 Skill 的完整 SKILL.md，不安装 Skill，也不执行原始任务。",
    "- 工具参数字段和允许值以当前 JSON Schema 为唯一依据。",
    "- 加载后遵守 SKILL.md；仅在其中明确引用且当前任务需要时读取附属资源。",
  ].join("\n"),
} as const;

export type SkillContextVersion = keyof typeof SKILL_USE_PROTOCOLS;

export interface SkillCatalogItem {
  name: string;
  description: string;
  trust: "builtin" | "approved" | "untrusted";
}

/**
 * 上下文版本必须显式存在；新增版本保留旧常量，环境变量即可精确回滚，
 * 不能在拼写错误时静默使用另一版提示词。
 */
export function configuredSkillContextVersion(
  value = process.env.MK_SKILL_CONTEXT_VERSION,
): SkillContextVersion {
  const version = value?.trim() || DEFAULT_SKILL_CONTEXT_VERSION;
  if (!(version in SKILL_USE_PROTOCOLS)) {
    throw new Error(`不支持的 Skill 上下文版本: ${version}`);
  }
  return version as SkillContextVersion;
}

export function skillUseProtocol(version: SkillContextVersion): string {
  return SKILL_USE_PROTOCOLS[version];
}

/** 动态层只序列化同一能力快照中的元数据，不重复携带固定行为说明。 */
export function skillCatalogContent(items: readonly SkillCatalogItem[]): string {
  return [
    "<available_skills>",
    JSON.stringify(items),
    "</available_skills>",
  ].join("\n");
}
