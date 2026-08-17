import type { SkillSource } from "@kindergarten/contracts";
import {
  parseGitHubSkillUrl,
  sameGitHubSource,
  type ParsedGitHubSkillSource,
} from "./github-skill-source.js";

export type ParsedSkillSource = ParsedGitHubSkillSource | {
  kind: "resource";
  sourceUrl: string;
  source: Extract<SkillSource, { kind: "resource_bundle" }>;
};

export interface ExplicitSkillSourceUrl {
  providedUrl: string;
  canonicalUrl: string;
}

export const DEFAULT_SKILL_RESOURCE_ORIGIN = "http://127.0.0.1:7342";

export function configuredSkillResourceOrigins(value: string | undefined): string[] {
  return (value ?? DEFAULT_SKILL_RESOURCE_ORIGIN)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 来源策略统一控制对话可见 URL 与服务端安装 URL，避免模型扩写或切换来源。 */
export class SkillSourceUrlPolicy {
  private readonly resourceOrigins: Set<string>;

  constructor(resourceOrigins: string[] = []) {
    this.resourceOrigins = new Set(resourceOrigins.map(normalizeResourceOrigin));
  }

  parse(value: string): ParsedSkillSource {
    let url: URL;
    try { url = new URL(value); }
    catch { throw new Error("SKILL_SOURCE_NOT_ALLOWED: Skill 来源 URL 无效"); }
    if (url.hostname.toLowerCase() === "github.com") return parseGitHubSkillUrl(value);
    if (!this.resourceOrigins.has(url.origin)) {
      throw new Error(`SKILL_SOURCE_NOT_ALLOWED: 未配置的 Skill 资源源站 ${url.origin}`);
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new Error("SKILL_SOURCE_NOT_ALLOWED: Skill 资源 URL 不得包含凭据、查询参数或片段");
    }
    const match = url.pathname.match(/^\/skills\/([a-z0-9-]+)\/?$/);
    if (!match) throw new Error("SKILL_SOURCE_NOT_ALLOWED: Skill 资源 URL 必须使用 /skills/{name}");
    const sourceUrl = `${url.origin}/skills/${match[1]}`;
    return {
      kind: "resource",
      sourceUrl,
      source: { kind: "resource_bundle", url: sourceUrl },
    };
  }

  explicitCandidates(text: string): ExplicitSkillSourceUrl[] {
    const matches = text.match(/https?:\/\/[^\s<>()"']+/gi) ?? [];
    const result: ExplicitSkillSourceUrl[] = [];
    const seen = new Set<string>();
    for (const match of matches) {
      const candidate = match.replace(/[，。；、,.;:!?！？]+$/, "");
      try {
        const canonicalUrl = this.parse(candidate).sourceUrl;
        if (!seen.has(candidate)) {
          result.push({ providedUrl: candidate, canonicalUrl });
          seen.add(candidate);
        }
      } catch { /* 普通网页 URL 不会获得 Skill 安装能力。 */ }
    }
    return result;
  }

  explicitUrls(text: string): string[] {
    return [...new Set(this.explicitCandidates(text).map((item) => item.canonicalUrl))];
  }

  sourceUrl(source: Exclude<SkillSource, { kind: "approved_local" }>): string {
    if (source.kind === "resource_bundle") return source.url;
    if (source.requestedRef === "HEAD" && source.subdirectory === ".") return source.repository;
    return `${source.repository}/tree/${encodeURIComponent(source.requestedRef)}/${source.subdirectory.split("/").map(encodeURIComponent).join("/")}`;
  }

  sameSource(left: SkillSource, right: SkillSource): boolean {
    if (left.kind === "github_tree" && right.kind === "github_tree") return sameGitHubSource(left, right);
    return left.kind === "resource_bundle" && right.kind === "resource_bundle" && left.url === right.url;
  }
}

function normalizeResourceOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error(`SKILL_RESOURCE_ORIGINS 包含无效 URL: ${value}`); }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error(`SKILL_RESOURCE_ORIGINS 只能配置无凭据的 origin: ${value}`);
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`Skill 资源源站只允许 HTTPS，或本机回环 HTTP: ${value}`);
  }
  return url.origin;
}
