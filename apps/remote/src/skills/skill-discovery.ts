import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { posix, resolve } from "node:path";
import type { SkillSource } from "@kindergarten/contracts";
import { GitRepository } from "../git/git-repository.js";

type GitHubSkillSource = Extract<SkillSource, { kind: "github_tree" }>;

export interface SkillDiscoveryPort {
  discoverGitHub(source: GitHubSkillSource): Promise<GitHubSkillSource[]>;
}

/** Skill 领域的发现规则：只返回第一次出现 SKILL.md 深度的全部目录。 */
export class SkillDiscovery implements SkillDiscoveryPort {
  constructor(private readonly workRoot: string) {}

  async discoverGitHub(source: GitHubSkillSource): Promise<GitHubSkillSource[]> {
    await mkdir(this.workRoot, { recursive: true });
    const quarantine = await mkdtemp(resolve(this.workRoot, ".discover-"));
    try {
      const repository = await GitRepository.clone(`${source.repository}.git`, resolve(quarantine, ".checkout"));
      const resolvedCommit = await repository.resolveCommit(source.requestedRef);
      const paths = await repository.listTreePaths(resolvedCommit, source.subdirectory);
      const found = discoverSkillDirectoriesFromGitTree(paths, source.subdirectory);
      if (found.length === 0) throw new Error("指定目录及其子目录中没有找到 SKILL.md");
      return found.map((subdirectory) => ({
        kind: "github_tree",
        repository: source.repository,
        requestedRef: source.requestedRef,
        resolvedCommit,
        subdirectory,
      }));
    } finally {
      await rm(quarantine, { recursive: true, force: true });
    }
  }
}

export async function discoverSkillDirectoriesAtFirstDepth(scope: string): Promise<string[]> {
  let directories = [scope];
  while (directories.length > 0) {
    const found: string[] = [];
    const next: string[] = [];
    for (const directory of directories) {
      const entries = await readdir(directory, { withFileTypes: true });
      if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
        found.push(directory);
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== ".git") next.push(resolve(directory, entry.name));
      }
    }
    if (found.length > 0) return found.toSorted();
    directories = next;
  }
  return [];
}

/** 只读 Git tree 元数据即可发现 Skill，不为目录发现 checkout 整个仓库。 */
export function discoverSkillDirectoriesFromGitTree(paths: string[], scope: string): string[] {
  const normalizedScope = scope === "." ? "" : scope.replace(/^\/+|\/+$/g, "");
  const prefix = normalizedScope ? `${normalizedScope}/` : "";
  const candidates = paths.flatMap((path) => {
    if (prefix && !path.startsWith(prefix)) return [];
    const relativePath = prefix ? path.slice(prefix.length) : path;
    if (posix.basename(relativePath) !== "SKILL.md") return [];
    const relativeDirectory = posix.dirname(relativePath);
    const depth = relativeDirectory === "." ? 0 : relativeDirectory.split("/").length;
    const directory = relativeDirectory === "."
      ? (normalizedScope || ".")
      : [normalizedScope, relativeDirectory].filter(Boolean).join("/");
    return [{ depth, directory }];
  });
  const firstDepth = Math.min(...candidates.map((candidate) => candidate.depth));
  if (!Number.isFinite(firstDepth)) return [];
  return [...new Set(candidates
    .filter((candidate) => candidate.depth === firstDepth)
    .map((candidate) => candidate.directory))].toSorted();
}
