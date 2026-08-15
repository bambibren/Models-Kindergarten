import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import type { SkillDefinition, SkillInstallRecord, SkillManifest } from "./skill-types.js";

const MAX_FILES = 200;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_SINGLE_FILE_BYTES = 256 * 1024;

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
  if (manifest.name !== basename(rootReal)) {
    throw new Error(`Skill name 必须与目录名一致: ${manifest.name} != ${basename(rootReal)}`);
  }
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
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    throw new Error("Skill name 必须是 1-64 位小写字母、数字和单连字符");
  }
  const description = requiredString(record.description, "Skill description");
  if (description.length > 1024) throw new Error("Skill description 超过 1024 字符");
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
  if (!input || input.length > 240 || input.includes("\\")) throw new Error("Skill 资源路径无效");
  const target = resolve(root, input);
  const rel = relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Skill 资源路径越界");
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("Skill 资源必须是普通文件");
  if (info.size > MAX_SINGLE_FILE_BYTES) throw new Error("Skill 资源超过大小限制");
  const actual = await realpath(target);
  const actualRel = relative(await realpath(root), actual);
  if (actualRel === ".." || actualRel.startsWith(`..${sep}`)) throw new Error("Skill 资源真实路径越界");
  return actual;
}

interface CollectedFile {
  path: string;
  relativePath: string;
  size: number;
}

async function collectFiles(root: string): Promise<CollectedFile[]> {
  const results: CollectedFile[] = [];
  let total = 0;
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) throw new Error(`Skill 不允许隐藏文件: ${entry.name}`);
      const path = resolve(directory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`Skill 不允许符号链接: ${entry.name}`);
      if (info.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!info.isFile()) throw new Error(`Skill 包含不支持的文件类型: ${entry.name}`);
      if ((info.mode & 0o111) !== 0 && !relative(root, path).startsWith(`scripts${sep}`)) {
        throw new Error(`Skill 可执行文件只能位于 scripts/: ${relative(root, path)}`);
      }
      if (info.size > MAX_SINGLE_FILE_BYTES) throw new Error(`Skill 文件超过大小限制: ${entry.name}`);
      total += info.size;
      if (total > MAX_TOTAL_BYTES) throw new Error("Skill 总大小超过 2 MiB");
      results.push({ path, relativePath: relative(root, path).split(sep).join("/"), size: info.size });
      if (results.length > MAX_FILES) throw new Error("Skill 文件数量超过 200");
    }
  }
  const rootInfo = await stat(root);
  if (!rootInfo.isDirectory()) throw new Error("Skill 根路径不是目录");
  await walk(root);
  return results;
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
