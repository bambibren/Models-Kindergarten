import { demoSkills } from "../demo-data.js";
import type { DemoAgentStrategy } from "../demo-types.js";
import { updateSelectedItems } from "../context-lab/context-lab-state.js";
import { publicSkillUrl } from "../../skills/public-skill-url.js";

export const demoSkillStorageKey = "models-kindergarten.demo-skills";

export const websiteSkillSources = [
  publicSkillUrl("website-design-fast"),
] as const;

export const websiteDevelopmentPrompt = `请先调用 ensure_agent_skills，把以下 Skill 安装到当前 Agent 并自动启用，安装就绪后再开始任务：

- ${websiteSkillSources[0]}

任务：为 Model Kindergarten 设计并生成一个静态课程介绍网站，输出可在浏览器中预览的 HTML，并列出页面结构。`;

/** 描述「DemoSkillLibraryStatus」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type DemoSkillLibraryStatus = "ready" | "draft";
/** 描述「DemoSkillInstallPhase」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type DemoSkillInstallPhase = "queued" | "fetching" | "validating" | "publishing" | "ready" | "reused" | "failed";

/** 描述「DemoSkillRecord」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface DemoSkillRecord {
  id: string;
  name: string;
  description: string;
  sourceUrl: string;
  status: DemoSkillLibraryStatus;
}

/** 描述「DemoSkillInstallItem」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface DemoSkillInstallItem {
  id: string;
  name: string;
  description: string;
  sourceUrl: string;
  phase: DemoSkillInstallPhase;
}

/** 描述「DemoSkillInstallBatch」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface DemoSkillInstallBatch {
  id: string;
  items: DemoSkillInstallItem[];
}

/** 描述「DemoSkillStorage」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface DemoSkillStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const sourceDescriptions: Record<string, string> = {
  "website-design-fast": "MK 网站快速设计 Skill",
  "frontend-design": "Anthropic 官方前端设计 Skill",
  "design-brief": "Open Design 设计简报 Skill",
  "impeccable-design-polish": "Open Design 视觉打磨 Skill",
};

const baseDemoSkills: DemoSkillRecord[] = demoSkills.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(skill) => ({
  id: skill.id,
  name: skill.name,
  description: skill.detail,
  sourceUrl: `local://${skill.name}`,
  status: skill.state === "已安装" ? "ready" : "draft",
}));

const phaseOrder: DemoSkillInstallPhase[] = ["queued", "fetching", "validating", "publishing", "ready"];

/** 校验并规范化「parseDemoSkillSource」输入，非法数据直接返回明确错误。 */
export function parseDemoSkillSource(sourceUrl: string): Omit<DemoSkillRecord, "id" | "status"> {
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl.trim());
  } catch {
    throw new Error("请输入完整的 Skill 地址");
  }
  if (parsed.origin === new URL(publicSkillUrl("website-design-fast")).origin) {
    const match = parsed.pathname.match(/^\/skills\/([a-z0-9-]+)\/?$/);
    if (!match || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Skill 资源地址必须使用 /skills/{name}");
    const name = match[1]!;
    return { name, description: sourceDescriptions[name] ?? "MK 静态资源 Skill", sourceUrl: `${parsed.origin}/skills/${name}` };
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("请输入当前 MK 的 Skill 资源地址或公开 GitHub HTTPS 地址");
  }
  const parts = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const isRepositoryRoot = parts.length === 2;
  const isTreeDirectory = parts.length >= 5 && parts[2] === "tree";
  if (!isRepositoryRoot && !isTreeDirectory) {
    throw new Error("地址必须指向 GitHub 仓库根目录或仓库内目录");
  }
  const name = parts.at(-1)?.replace(/\.git$/i, "");
  if (!name) throw new Error("Skill 目录名称不能为空");
  return {
    name,
    description: sourceDescriptions[name] ?? "从 GitHub 安装的用户 Skill",
    sourceUrl: parsed.toString().replace(/\.git\/?$/i, "").replace(/\/$/, ""),
  };
}

/** 读取「loadSavedDemoSkills」所需数据，并遵守作用域、分页与容量边界。 */
export function loadSavedDemoSkills(storage: DemoSkillStorage): DemoSkillRecord[] {
  const raw = storage.getItem(demoSkillStorageKey);
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter(isDemoSkillRecord) : [];
  } catch {
    return [];
  }
}

/** 读取「listDemoSkills」所需数据，并遵守作用域、分页与容量边界。 */
export function listDemoSkills(storage: DemoSkillStorage): DemoSkillRecord[] {
  return mergeDemoSkills(loadSavedDemoSkills(storage), baseDemoSkills);
}

/** 更新「saveDemoSkills」对应状态，并保持写入顺序、原子性与容量约束。 */
export function saveDemoSkills(storage: DemoSkillStorage, records: DemoSkillRecord[]): DemoSkillRecord[] {
  const saved = loadSavedDemoSkills(storage);
  const merged = mergeDemoSkills(records, saved);
  storage.setItem(demoSkillStorageKey, JSON.stringify(merged));
  return listDemoSkills(storage);
}

/** 汇总「mergeDemoSkills」对应指标，保持缺失字段语义且不重复计算同一来源。 */
export function mergeDemoSkills(preferred: DemoSkillRecord[], fallback: DemoSkillRecord[]): DemoSkillRecord[] {
  const names = new Set(preferred.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(skill) => skill.name));
  return [...preferred, ...fallback.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(skill) => !names.has(skill.name))];
}

/** 根据已校验输入构建「createDemoSkillInstallBatch」结果，不额外持有调用方的大对象。 */
export function createDemoSkillInstallBatch(sourceUrls: readonly string[], library: DemoSkillRecord[], id = `skill-install-${Date.now()}`): DemoSkillInstallBatch {
  const seen = new Set<string>();
  const items = sourceUrls.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(sourceUrl, index) => {
    const parsed = parseDemoSkillSource(sourceUrl);
    if (seen.has(parsed.sourceUrl)) throw new Error(`重复的 Skill 地址：${parsed.name}`);
    seen.add(parsed.sourceUrl);
    const sameName = library.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(skill) => skill.name === parsed.name);
    if (sameName && sameName.sourceUrl !== parsed.sourceUrl) throw new Error(`Skill 名称冲突：${parsed.name}`);
    const reused = sameName?.status === "ready" && sameName.sourceUrl === parsed.sourceUrl;
    return {
      id: `${id}-${index + 1}`,
      ...parsed,
      phase: reused ? "reused" as const : "queued" as const,
    };
  });
  if (items.length === 0) throw new Error("请至少提供一个 Skill 地址");
  return { id, items };
}

/** 执行「advanceDemoSkillInstallBatch」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function advanceDemoSkillInstallBatch(batch: DemoSkillInstallBatch): DemoSkillInstallBatch {
  if (isDemoSkillInstallComplete(batch) || hasDemoSkillInstallFailed(batch)) return batch;
  return {
    ...batch,
    items: batch.items.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => {
      if (item.phase === "reused" || item.phase === "ready" || item.phase === "failed") return item;
      const index = phaseOrder.indexOf(item.phase);
      return { ...item, phase: phaseOrder[index + 1] ?? "failed" };
    }),
  };
}

/** 判断「isDemoSkillInstallComplete」对应条件，只返回判定结果且不修改输入状态。 */
export function isDemoSkillInstallComplete(batch: DemoSkillInstallBatch): boolean {
  return batch.items.every(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.phase === "ready" || item.phase === "reused");
}

/** 判断「hasDemoSkillInstallFailed」对应条件，只返回判定结果且不修改输入状态。 */
export function hasDemoSkillInstallFailed(batch: DemoSkillInstallBatch): boolean {
  return batch.items.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.phase === "failed");
}

/** 执行「skillInstallProgress」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function skillInstallProgress(batch: DemoSkillInstallBatch): { completed: number; total: number; phase: DemoSkillInstallPhase } {
  const completed = batch.items.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.phase === "ready" || item.phase === "reused").length;
  const active = batch.items.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.phase !== "ready" && item.phase !== "reused");
  return { completed, total: batch.items.length, phase: active?.phase ?? "ready" };
}

/** 执行「installedRecordsFromBatch」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function installedRecordsFromBatch(batch: DemoSkillInstallBatch): DemoSkillRecord[] {
  return batch.items.flatMap(/** 执行「installedRecordsFromBatch」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(item) => item.phase === "ready" || item.phase === "reused" ? [{
    id: `skill-${item.name}`,
    name: item.name,
    description: item.description,
    sourceUrl: item.sourceUrl,
    status: "ready" as const,
  }] : []);
}

/** 执行「bindSkillsToAgent」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function bindSkillsToAgent(agent: DemoAgentStrategy, skillNames: string[]): DemoAgentStrategy {
  return {
    ...agent,
    updatedAt: "刚刚",
    modules: agent.modules.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(module) => {
      if (module.id !== "skills") return module;
      const selectedItems = [...new Set([...(module.selectedItems ?? []), ...skillNames])];
      return updateSelectedItems(module, selectedItems);
    }),
  };
}

/** 判断「isWebsiteDevelopmentRequest」对应条件，只返回判定结果且不修改输入状态。 */
export function isWebsiteDevelopmentRequest(value: string): boolean {
  return value.includes("ensure_agent_skills") && websiteSkillSources.every(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(sourceUrl) => value.includes(sourceUrl));
}

/** 执行「demoSkillPhaseLabel」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function demoSkillPhaseLabel(phase: DemoSkillInstallPhase): string {
  return {
    queued: "等待安装",
    fetching: "正在拉取",
    validating: "正在校验",
    publishing: "正在发布",
    ready: "安装成功",
    reused: "已安装，直接复用",
    failed: "安装失败",
  }[phase];
}

/** 判断「isDemoSkillRecord」对应条件，只返回判定结果且不修改输入状态。 */
function isDemoSkillRecord(value: unknown): value is DemoSkillRecord {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<DemoSkillRecord>;
  return typeof item.id === "string"
    && typeof item.name === "string"
    && typeof item.description === "string"
    && typeof item.sourceUrl === "string"
    && (item.status === "ready" || item.status === "draft");
}
