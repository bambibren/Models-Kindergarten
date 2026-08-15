import { demoSkills } from "../demo-data.js";
import type { DemoAgentStrategy } from "../demo-types.js";
import { updateSelectedItems } from "../context-lab/context-lab-state.js";

export const demoSkillStorageKey = "models-kindergarten.demo-skills";

export const websiteSkillSources = [
  "https://github.com/anthropics/skills/tree/main/skills/frontend-design",
  "https://github.com/nexu-io/open-design/tree/main/skills/design-brief",
  "https://github.com/nexu-io/open-design/tree/main/skills/impeccable-design-polish",
] as const;

export const websiteDevelopmentPrompt = `请先调用 ensure_agent_skills，把以下 3 个 Skills 安装到当前 Agent 并自动启用，安装全部就绪后再开始任务：

- ${websiteSkillSources[0]}
- ${websiteSkillSources[1]}
- ${websiteSkillSources[2]}

任务：为 Model Kindergarten 设计并生成一个静态课程介绍网站，输出可在浏览器中预览的 HTML，并列出页面结构。`;

export type DemoSkillLibraryStatus = "ready" | "draft";
export type DemoSkillInstallPhase = "queued" | "fetching" | "validating" | "publishing" | "ready" | "reused" | "failed";

export interface DemoSkillRecord {
  id: string;
  name: string;
  description: string;
  sourceUrl: string;
  status: DemoSkillLibraryStatus;
}

export interface DemoSkillInstallItem {
  id: string;
  name: string;
  description: string;
  sourceUrl: string;
  phase: DemoSkillInstallPhase;
}

export interface DemoSkillInstallBatch {
  id: string;
  items: DemoSkillInstallItem[];
}

export interface DemoSkillStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const sourceDescriptions: Record<string, string> = {
  "frontend-design": "Anthropic 官方前端设计 Skill",
  "design-brief": "Open Design 设计简报 Skill",
  "impeccable-design-polish": "Open Design 视觉打磨 Skill",
};

const baseDemoSkills: DemoSkillRecord[] = demoSkills.map((skill) => ({
  id: skill.id,
  name: skill.name,
  description: skill.detail,
  sourceUrl: `local://${skill.name}`,
  status: skill.state === "已安装" ? "ready" : "draft",
}));

const phaseOrder: DemoSkillInstallPhase[] = ["queued", "fetching", "validating", "publishing", "ready"];

export function parseDemoSkillSource(sourceUrl: string): Omit<DemoSkillRecord, "id" | "status"> {
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl.trim());
  } catch {
    throw new Error("请输入完整的 GitHub Skill 地址");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Demo 只接受公开 GitHub HTTPS 地址");
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

export function listDemoSkills(storage: DemoSkillStorage): DemoSkillRecord[] {
  return mergeDemoSkills(loadSavedDemoSkills(storage), baseDemoSkills);
}

export function saveDemoSkills(storage: DemoSkillStorage, records: DemoSkillRecord[]): DemoSkillRecord[] {
  const saved = loadSavedDemoSkills(storage);
  const merged = mergeDemoSkills(records, saved);
  storage.setItem(demoSkillStorageKey, JSON.stringify(merged));
  return listDemoSkills(storage);
}

export function mergeDemoSkills(preferred: DemoSkillRecord[], fallback: DemoSkillRecord[]): DemoSkillRecord[] {
  const names = new Set(preferred.map((skill) => skill.name));
  return [...preferred, ...fallback.filter((skill) => !names.has(skill.name))];
}

export function createDemoSkillInstallBatch(sourceUrls: readonly string[], library: DemoSkillRecord[], id = `skill-install-${Date.now()}`): DemoSkillInstallBatch {
  const seen = new Set<string>();
  const items = sourceUrls.map((sourceUrl, index) => {
    const parsed = parseDemoSkillSource(sourceUrl);
    if (seen.has(parsed.sourceUrl)) throw new Error(`重复的 Skill 地址：${parsed.name}`);
    seen.add(parsed.sourceUrl);
    const sameName = library.find((skill) => skill.name === parsed.name);
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

export function advanceDemoSkillInstallBatch(batch: DemoSkillInstallBatch): DemoSkillInstallBatch {
  if (isDemoSkillInstallComplete(batch) || hasDemoSkillInstallFailed(batch)) return batch;
  return {
    ...batch,
    items: batch.items.map((item) => {
      if (item.phase === "reused" || item.phase === "ready" || item.phase === "failed") return item;
      const index = phaseOrder.indexOf(item.phase);
      return { ...item, phase: phaseOrder[index + 1] ?? "failed" };
    }),
  };
}

export function isDemoSkillInstallComplete(batch: DemoSkillInstallBatch): boolean {
  return batch.items.every((item) => item.phase === "ready" || item.phase === "reused");
}

export function hasDemoSkillInstallFailed(batch: DemoSkillInstallBatch): boolean {
  return batch.items.some((item) => item.phase === "failed");
}

export function skillInstallProgress(batch: DemoSkillInstallBatch): { completed: number; total: number; phase: DemoSkillInstallPhase } {
  const completed = batch.items.filter((item) => item.phase === "ready" || item.phase === "reused").length;
  const active = batch.items.find((item) => item.phase !== "ready" && item.phase !== "reused");
  return { completed, total: batch.items.length, phase: active?.phase ?? "ready" };
}

export function installedRecordsFromBatch(batch: DemoSkillInstallBatch): DemoSkillRecord[] {
  return batch.items.flatMap((item) => item.phase === "ready" || item.phase === "reused" ? [{
    id: `skill-${item.name}`,
    name: item.name,
    description: item.description,
    sourceUrl: item.sourceUrl,
    status: "ready" as const,
  }] : []);
}

export function bindSkillsToAgent(agent: DemoAgentStrategy, skillNames: string[]): DemoAgentStrategy {
  return {
    ...agent,
    updatedAt: "刚刚",
    modules: agent.modules.map((module) => {
      if (module.id !== "skills") return module;
      const selectedItems = [...new Set([...(module.selectedItems ?? []), ...skillNames])];
      return updateSelectedItems(module, selectedItems);
    }),
  };
}

export function isWebsiteDevelopmentRequest(value: string): boolean {
  return value.includes("ensure_agent_skills") && websiteSkillSources.every((sourceUrl) => value.includes(sourceUrl));
}

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

function isDemoSkillRecord(value: unknown): value is DemoSkillRecord {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<DemoSkillRecord>;
  return typeof item.id === "string"
    && typeof item.name === "string"
    && typeof item.description === "string"
    && typeof item.sourceUrl === "string"
    && (item.status === "ready" || item.status === "draft");
}
