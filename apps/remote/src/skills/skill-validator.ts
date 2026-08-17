import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { PRODUCT_CONFIG } from "@kindergarten/contracts";
import { parse as parseYaml } from "yaml";
import type { SkillDefinition, SkillInstallRecord, SkillManifest } from "./skill-types.js";

/** 校验 Agent Skills 标准字段，并把整个目录内容固定为一个可复现 Hash。 */
export async function validateSkillDirectory(
  root: string,
  base: Omit<SkillInstallRecord, "name" | "description" | "rootPath" | "contentHash" | "manifest">,
): Promise<SkillDefinition> {
  const rootReal = await realpath(root);
  const files = await collectFiles(rootReal);
  const skillFile = files.find((item) => item.relativePath === "SKILL.md");
  if (!skillFile) throw new Error("Skill 根目录缺少 SKILL.md");
  const raw = await readFile(skillFile.path, "utf8");
  const { manifest, instructions } = parseSkillMarkdown(raw);
  const hash = createHash("sha256");
  for (const file of files.toSorted((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    hash.update(file.relativePath).update("\0").update(await readFile(file.path)).update("\0");
  }
  return {
    ...base,
    name: manifest.name,
    description: manifest.description,
    rootPath: rootReal,
    contentHash: hash.digest("hex"),
    manifest,
    instructions,
  };
}

export function parseSkillMarkdown(value: string): {
  manifest: SkillManifest;
  instructions: string;
} {
  const match = value.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new Error("SKILL.md 必须以 YAML frontmatter 开头");
  const frontmatter = parseYaml(match[1] ?? "") as unknown;
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    throw new Error("SKILL.md frontmatter 必须是对象");
  }
  const record = frontmatter as Record<string, unknown>;
  const name = requiredString(record.name, "Skill name");
  assertSafeSkillName(name);
  const description = requiredString(record.description, "Skill description");
  const instructions = match[2]?.trim() ?? "";
  if (!instructions) throw new Error("SKILL.md 指令正文不能为空");
  const manifest: SkillManifest = {
    name,
    description,
    ...(optionalString(record.license, "license") ? { license: optionalString(record.license, "license")! } : {}),
    ...(optionalString(record.compatibility, "compatibility")
      ? { compatibility: optionalString(record.compatibility, "compatibility")! }
      : {}),
    ...(record["allowed-tools"] === undefined
      ? {}
      : { allowedTools: requiredString(record["allowed-tools"], "allowed-tools").split(/\s+/).filter(Boolean) }),
    ...(record.metadata === undefined ? {} : { metadata: metadata(record.metadata) }),
  };
  return { manifest, instructions };
}

export async function assertSkillResource(root: string, input: string): Promise<string> {
  if (!input || input.includes("\\")) throw new Error("Skill 资源路径无效");
  const target = resolve(root, input);
  const rel = relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Skill 资源路径越界");
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("Skill 资源必须是普通文件");
  const actual = await realpath(target);
  const actualRel = relative(await realpath(root), actual);
  if (actualRel === ".." || actualRel.startsWith(`..${sep}`)) throw new Error("Skill 资源真实路径越界");
  return actual;
}

interface CollectedFile {
  path: string;
  relativePath: string;
}

async function collectFiles(root: string): Promise<CollectedFile[]> {
  const results: CollectedFile[] = [];
  let total = 0;
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`Skill 不允许符号链接: ${entry.name}`);
      if (info.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!info.isFile()) throw new Error(`Skill 包含不支持的文件类型: ${entry.name}`);
      total += info.size;
      if (total > PRODUCT_CONFIG.skill.maxTotalBytes) {
        throw new Error(`Skill 总大小超过 ${PRODUCT_CONFIG.skill.maxTotalBytes} 字节`);
      }
      results.push({ path, relativePath: relative(root, path).split(sep).join("/") });
      if (results.length > PRODUCT_CONFIG.skill.maxFiles) {
        throw new Error(`Skill 文件数量超过 ${PRODUCT_CONFIG.skill.maxFiles}`);
      }
    }
  }
  const rootInfo = await stat(root);
  if (!rootInfo.isDirectory()) throw new Error("Skill 根路径不是目录");
  await walk(root);
  return results;
}

/** Skill 名称不限定展示格式，只禁止把名称解释成文件路径。 */
export function assertSafeSkillName(value: string): void {
  if (value === "." || value === ".." || value.includes("/") || value.includes("\\") || value.includes("\0")) {
    throw new Error("Skill name 不得包含路径");
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 必须是非空字符串`);
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label);
}

function metadata(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Skill metadata 必须是对象");
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
    if (typeof item !== "string") throw new Error(`Skill metadata.${key} 必须是字符串`);
    return [key, item];
  }));
}
