import type { SkillSource } from "@kindergarten/contracts";
import {
  parseGitHubSkillUrl,
  sameGitHubSource,
  type ParsedGitHubSkillSource,
} from "./github-skill-source.js";

/** 描述「ParsedSkillSource」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ParsedSkillSource = ParsedGitHubSkillSource | {
  kind: "resource";
  sourceUrl: string;
  source: Extract<SkillSource, { kind: "resource_bundle" }>;
};

/** 描述「ExplicitSkillSourceUrl」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ExplicitSkillSourceUrl {
  providedUrl: string;
  canonicalUrl: string;
}

export const DEFAULT_SKILL_RESOURCE_ORIGIN = "http://127.0.0.1:5173";
export const DEFAULT_SKILL_RESOURCE_FETCH_BASE = "http://127.0.0.1:7342";

/** 执行「configuredSkillResourceOrigins」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function configuredSkillResourceOrigins(value: string | undefined): string[] {
  return (value ?? DEFAULT_SKILL_RESOURCE_ORIGIN)
    .split(",")
    .map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.trim())
    .filter(Boolean);
}

/** 读取 Resource 的内部下载基址；它由部署者配置，不接受用户消息覆盖。 */
export function configuredSkillResourceFetchBase(value: string | undefined): string {
  return normalizeFetchBase(value ?? DEFAULT_SKILL_RESOURCE_FETCH_BASE);
}

/** 公开 URL 只用于授权和记录；实际下载替换为受信内部基址并保留规范 Skill 路径。 */
export function skillResourceFetchUrl(publicUrl: string, fetchBase: string): string {
  const source = new URL(publicUrl);
  if (!/^\/skills\/[a-z0-9-]+\/?$/.test(source.pathname) || source.search || source.hash) {
    throw new Error(`SKILL_SOURCE_NOT_ALLOWED: Skill 资源 URL 必须使用 /skills/{name}`);
  }
  return new URL(source.pathname.replace(/\/$/, ""), `${normalizeFetchBase(fetchBase)}/`).href;
}

/** 来源策略统一控制对话可见 URL 与服务端安装 URL，避免模型扩写或切换来源。 */
export class SkillSourceUrlPolicy {
  private readonly resourceOrigins: Set<string>;

  /** 初始化「SkillSourceUrlPolicy」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(resourceOrigins: string[] = [], options: { allowInsecureHttp?: boolean } = {}) {
    this.resourceOrigins = new Set(resourceOrigins.map((origin) => normalizeResourceOrigin(origin, options.allowInsecureHttp === true)));
  }

  /** 校验并规范化「parse」输入，非法数据直接返回明确错误。 */
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

  /** 执行「explicitCandidates」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
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

  /** 执行「explicitUrls」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
explicitUrls(text: string): string[] {
    return [...new Set(this.explicitCandidates(text).map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.canonicalUrl))];
  }

  /** 执行「sourceUrl」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
sourceUrl(source: Exclude<SkillSource, { kind: "approved_local" }>): string {
    if (source.kind === "resource_bundle") return source.url;
    if (source.requestedRef === "HEAD" && source.subdirectory === ".") return source.repository;
    return `${source.repository}/tree/${encodeURIComponent(source.requestedRef)}/${source.subdirectory.split("/").map(encodeURIComponent).join("/")}`;
  }

  /** 执行「sameSource」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
sameSource(left: SkillSource, right: SkillSource): boolean {
    if (left.kind === "github_tree" && right.kind === "github_tree") return sameGitHubSource(left, right);
    return left.kind === "resource_bundle" && right.kind === "resource_bundle" && left.url === right.url;
  }
}

/** 校验并规范化「normalizeResourceOrigin」输入，非法数据直接返回明确错误。 */
function normalizeResourceOrigin(value: string, allowInsecureHttp: boolean): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error(`SKILL_RESOURCE_ORIGINS 包含无效 URL: ${value}`); }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error(`SKILL_RESOURCE_ORIGINS 只能配置无凭据的 origin: ${value}`);
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (loopback || allowInsecureHttp))) {
    throw new Error(`Skill 资源源站只允许 HTTPS，或本机回环 HTTP: ${value}`);
  }
  return url.origin;
}

/** 内部下载基址来自受控部署配置，可使用 Docker 内网 HTTP 服务名。 */
function normalizeFetchBase(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error(`SKILL_RESOURCE_FETCH_BASE 包含无效 URL: ${value}`); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash ||
    (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error(`SKILL_RESOURCE_FETCH_BASE 只能配置 HTTP(S) origin: ${value}`);
  }
  return url.origin;
}
