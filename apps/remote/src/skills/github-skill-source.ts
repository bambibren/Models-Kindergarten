import type { SkillSource } from "@kindergarten/contracts";

/** 描述「ParsedGitHubSkillSource」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ParsedGitHubSkillSource =
  | {
      kind: "repository";
      sourceUrl: string;
      repository: string;
      cloneUrl: string;
      source: Extract<SkillSource, { kind: "github_tree" }>;
    }
  | {
      kind: "tree";
      sourceUrl: string;
      repository: string;
      cloneUrl: string;
      source: Extract<SkillSource, { kind: "github_tree" }>;
    };

/** 描述「ExplicitGitHubSkillUrl」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ExplicitGitHubSkillUrl {
  providedUrl: string;
  canonicalUrl: string;
}

/**
 * 当前产品只支持 GitHub 仓库根地址与明确的 /tree/ref/path 地址。
 * 这里只解析来源语义，不判断仓库内 Skill 的目录深度。
 */
export function parseGitHubSkillUrl(value: string): ParsedGitHubSkillSource {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("SKILL_SOURCE_NOT_ALLOWED: Skill 来源 URL 无效"); }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.username || url.password || url.search || url.hash) {
    throw new Error("SKILL_SOURCE_NOT_ALLOWED: 只支持无凭据的 GitHub HTTPS 仓库 URL");
  }
  let parts: string[];
  try { parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent); }
  catch { throw new Error("SKILL_SOURCE_NOT_ALLOWED: Skill 来源 URL 编码无效"); }
  const [owner, rawRepositoryName, route, requestedRef, ...subdirectoryParts] = parts;
  const repositoryName = rawRepositoryName?.replace(/\.git$/i, "");
  if (!owner || !repositoryName || !safePart(owner) || !safePart(repositoryName)) {
    throw new Error("SKILL_SOURCE_NOT_ALLOWED: GitHub 仓库地址必须包含 owner/repository");
  }
  const repository = `https://github.com/${owner}/${repositoryName}`;
  const common = { repository, cloneUrl: `${repository}.git` };
  if (parts.length === 2) {
    return {
      kind: "repository",
      sourceUrl: repository,
      ...common,
      source: { kind: "github_tree", repository, requestedRef: "HEAD", subdirectory: "." },
    };
  }
  if (route !== "tree" || !requestedRef || subdirectoryParts.length === 0) {
    throw new Error("SKILL_SOURCE_NOT_ALLOWED: 请提供 GitHub 仓库地址；旧 tree URL 需包含 ref 和目录");
  }
  if (![requestedRef, ...subdirectoryParts].every(safePart)) {
    throw new Error("SKILL_SOURCE_NOT_ALLOWED: Skill 来源包含不安全路径");
  }
  const subdirectory = subdirectoryParts.join("/");
  return {
    kind: "tree",
    sourceUrl: `${repository}/tree/${encodeURIComponent(requestedRef)}/${subdirectoryParts.map(encodeURIComponent).join("/")}`,
    ...common,
    source: { kind: "github_tree", repository, requestedRef, subdirectory },
  };
}

/** 执行「explicitGitHubSkillUrls」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function explicitGitHubSkillUrls(text: string): string[] {
  return [...new Set(explicitGitHubSkillUrlCandidates(text).map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.canonicalUrl))];
}

/** 模型可见候选保留用户原始写法；canonicalUrl 只用于服务端授权比较。 */
export function explicitGitHubSkillUrlCandidates(text: string): ExplicitGitHubSkillUrl[] {
  const matches = text.match(/https:\/\/github\.com\/[^\s<>()"']+/gi) ?? [];
  const valid: ExplicitGitHubSkillUrl[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    const candidate = match.replace(/[，。；、,.;:!?！？]+$/, "");
    try {
      const canonicalUrl = parseGitHubSkillUrl(candidate).sourceUrl;
      if (!seen.has(candidate)) {
        valid.push({ providedUrl: candidate, canonicalUrl });
        seen.add(candidate);
      }
    }
    catch { /* 非 Skill 仓库 URL 不会获得安装能力。 */ }
  }
  return valid;
}

/** 执行「sameGitHubSource」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function sameGitHubSource(
  left: Extract<SkillSource, { kind: "github_tree" }>,
  right: Extract<SkillSource, { kind: "github_tree" }>,
): boolean {
  return left.repository.toLowerCase() === right.repository.toLowerCase() &&
    left.requestedRef === right.requestedRef && left.subdirectory === right.subdirectory;
}

/** 执行「safePart」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function safePart(value: string): boolean {
  return value !== "." && value !== ".." && !value.includes("\\") && !value.includes("/") && value.length <= 160;
}
