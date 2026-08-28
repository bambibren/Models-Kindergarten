import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { posix, resolve } from "node:path";
import type { SkillSource } from "@kindergarten/contracts";
import { GitRepository } from "../git/git-repository.js";

type GitHubSkillSource = Extract<SkillSource, { kind: "github_tree" }>;

/** 描述「SkillDiscoveryPort」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface SkillDiscoveryPort {
  discoverGitHub(source: GitHubSkillSource): Promise<GitHubSkillSource[]>;
}

/** Skill 领域的发现规则：只返回第一次出现 SKILL.md 深度的全部目录。 */
export class SkillDiscovery implements SkillDiscoveryPort {
  /** 初始化「SkillDiscovery」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(private readonly workRoot: string) {}

  /** 执行「discoverGitHub」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async discoverGitHub(source: GitHubSkillSource): Promise<GitHubSkillSource[]> {
    await mkdir(this.workRoot, { recursive: true });
    const quarantine = await mkdtemp(resolve(this.workRoot, ".discover-"));
    try {
      const repository = await GitRepository.clone(`${source.repository}.git`, resolve(quarantine, ".checkout"));
      const resolvedCommit = await repository.resolveCommit(source.requestedRef);
      const paths = await repository.listTreePaths(resolvedCommit, source.subdirectory);
      const found = discoverSkillDirectoriesFromGitTree(paths, source.subdirectory);
      if (found.length === 0) throw new Error("指定目录及其子目录中没有找到 SKILL.md");
      return found.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(subdirectory) => ({
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

/** 执行「discoverSkillDirectoriesAtFirstDepth」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export async function discoverSkillDirectoriesAtFirstDepth(scope: string): Promise<string[]> {
  let directories = [scope];
  while (directories.length > 0) {
    const found: string[] = [];
    const next: string[] = [];
    for (const directory of directories) {
      const entries = await readdir(directory, { withFileTypes: true });
      if (entries.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(entry) => entry.isFile() && entry.name === "SKILL.md")) {
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
  const candidates = paths.flatMap(/** 判断「candidates」对应条件，只返回判定结果且不修改输入状态。 */
(path) => {
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
  const firstDepth = Math.min(...candidates.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(candidate) => candidate.depth));
  if (!Number.isFinite(firstDepth)) return [];
  return [...new Set(candidates
    .filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(candidate) => candidate.depth === firstDepth)
    .map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(candidate) => candidate.directory))].toSorted();
}
