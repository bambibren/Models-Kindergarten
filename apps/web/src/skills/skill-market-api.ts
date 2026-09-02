export interface SkillMarketEntry {
  name: string;
  url: string;
  displayName: string;
  description: string;
  category: string;
}

interface SkillMarketResponse {
  schemaVersion: 1;
  skills: SkillMarketEntry[];
}

/** 读取与页面同源发布的 Skill 中文目录；静态资源只提供事实，不参与账号安装写入。 */
export async function readSkillMarket(fetchImpl: typeof fetch = fetch): Promise<SkillMarketEntry[]> {
  const response = await fetchImpl("/skills", { credentials: "same-origin" });
  if (!response.ok) throw new Error(`Skill 市场读取失败：HTTP ${response.status}`);
  const value = await response.json() as unknown;
  if (!isMarketResponse(value)) throw new Error("Skill 市场目录结构无效");
  return value.skills;
}

/** 按中文名称、资源名、说明与分类过滤，查询为空时保留完整目录顺序。 */
export function filterSkillMarket(
  skills: SkillMarketEntry[],
  query: string,
  category: string,
): SkillMarketEntry[] {
  const normalized = query.trim().toLocaleLowerCase("zh-CN");
  return skills.filter((skill) => {
    if (category !== "全部" && skill.category !== category) return false;
    if (!normalized) return true;
    return `${skill.displayName}\n${skill.name}\n${skill.description}\n${skill.category}`
      .toLocaleLowerCase("zh-CN")
      .includes(normalized);
  });
}

function isMarketResponse(value: unknown): value is SkillMarketResponse {
  if (!record(value) || value.schemaVersion !== 1 || !Array.isArray(value.skills)) return false;
  const names = new Set<string>();
  return value.skills.every((item) => {
    if (!record(item) || typeof item.name !== "string" || !/^[a-z0-9-]+$/.test(item.name) ||
      typeof item.url !== "string" || item.url !== `/skills/${item.name}` ||
      typeof item.displayName !== "string" || !item.displayName.trim() ||
      typeof item.description !== "string" || !item.description.trim() ||
      typeof item.category !== "string" || !item.category.trim() || names.has(item.name)) return false;
    names.add(item.name);
    return true;
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
