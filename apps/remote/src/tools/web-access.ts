import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { PRODUCT_CONFIG } from "@kindergarten/contracts";
import { DependencyCircuits } from "../resilience/circuit-breaker.js";
import { ToolExecutionError } from "./tool-error.js";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebFetchResult {
  url: string;
  contentType: string;
  text: string;
  truncated: boolean;
}

export interface WebToolClient {
  search(query: string, maxResults: number, signal: AbortSignal): Promise<WebSearchResult[]>;
  fetch(url: string, signal: AbortSignal): Promise<WebFetchResult>;
}

/** 无密钥搜索用于本地演示；所有目标 URL 都先做私网与响应大小校验。 */
export class WebAccess implements WebToolClient {
  private readonly circuits = new DependencyCircuits();

  constructor(
    private readonly searchEndpoint = process.env.WEB_SEARCH_ENDPOINT ?? "https://www.bing.com/search",
  ) {}

  async search(
    query: string,
    maxResults: number,
    signal: AbortSignal,
  ): Promise<WebSearchResult[]> {
    if (!query.trim()) throw new Error("query 不能为空");
    if (query.length > PRODUCT_CONFIG.tools.web.queryMaxCharacters) {
      throw new ToolExecutionError(
        "web_query_too_long",
        "resource_limit",
        `搜索词超过 ${PRODUCT_CONFIG.tools.web.queryMaxCharacters} 个字符资源上限`,
        false,
      );
    }
    if (maxResults > PRODUCT_CONFIG.tools.web.maxSearchResults) {
      throw new ToolExecutionError(
        "web_search_result_limit_exceeded",
        "resource_limit",
        `搜索结果请求数 ${maxResults}，超过 ${PRODUCT_CONFIG.tools.web.maxSearchResults} 条资源上限`,
        false,
      );
    }
    const url = new URL(this.searchEndpoint);
    url.searchParams.set("q", query);
    const response = await this.request(url, signal, {
      headers: {
        "user-agent": "Models-Kindergarten/0.3",
      },
    });
    const html = await response.text();
    return parseBing(html).slice(0, clamp(
      maxResults,
      PRODUCT_CONFIG.tools.web.minSearchResults,
      PRODUCT_CONFIG.tools.web.maxSearchResults,
    ));
  }

  async fetch(input: string, signal: AbortSignal): Promise<WebFetchResult> {
    const response = await this.request(new URL(input), signal);
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    if (!/^(text\/|application\/(json|xml|xhtml\+xml))/i.test(contentType)) {
      throw new Error(`不支持的网页内容类型: ${contentType}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const decoded = new TextDecoder().decode(bytes);
    const text = /html/i.test(contentType) ? htmlToText(decoded) : decoded;
    return {
      url: response.headers.get("x-kindergarten-final-url") ?? input,
      contentType,
      text: text.slice(0, PRODUCT_CONFIG.tools.web.maxModelTextCharacters),
      truncated: bytes.length >= PRODUCT_CONFIG.tools.web.maxFetchBytes ||
        text.length > PRODUCT_CONFIG.tools.web.maxModelTextCharacters,
    };
  }

  private async request(
    initial: URL,
    signal: AbortSignal,
    init: RequestInit = {},
  ): Promise<Response> {
    let url = initial;
    for (let redirect = 0; redirect <= PRODUCT_CONFIG.tools.web.maxRedirects; redirect += 1) {
      await assertPublicUrl(url);
      const combined = AbortSignal.any([signal, AbortSignal.timeout(PRODUCT_CONFIG.tools.web.requestTimeoutMs)]);
      const breaker = this.circuits.get(`http-origin:${url.origin}`);
      let response: Response;
      try {
        response = await breaker.execute(async () => {
          const value = await fetch(url, { ...init, redirect: "manual", signal: combined });
          if (value.status === 429 || value.status >= 500) {
            await value.body?.cancel();
            throw new ToolExecutionError(
              "web_transient_http",
              "network",
              `网页请求暂时失败 (HTTP ${value.status})`,
              true,
              { status: value.status, url: url.href },
            );
          }
          return value;
        });
      } catch (error) {
        if (error instanceof ToolExecutionError) throw error;
        if (error instanceof DOMException && error.name === "TimeoutError") {
          throw new ToolExecutionError("web_timeout", "timeout", "网页请求超时", true, { url: url.href }, { cause: error });
        }
        if (error instanceof TypeError) {
          throw new ToolExecutionError("web_network_failed", "network", "网页网络请求失败", true, { url: url.href }, { cause: error });
        }
        throw error;
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new Error("网页重定向缺少 Location");
        url = new URL(location, url);
        continue;
      }
      if (!response.ok) throw new Error(`网页请求失败 (${response.status})`);
      const length = Number(response.headers.get("content-length") ?? "0");
      if (length > PRODUCT_CONFIG.tools.web.maxFetchBytes) {
        await response.body?.cancel();
        throw responseTooLarge(PRODUCT_CONFIG.tools.web.maxFetchBytes);
      }
      return limitResponse(response, PRODUCT_CONFIG.tools.web.maxFetchBytes, url.href);
    }
    throw new ToolExecutionError(
      "web_redirect_limit_exceeded",
      "resource_limit",
      `网页重定向超过 ${PRODUCT_CONFIG.tools.web.maxRedirects} 次资源上限`,
      false,
    );
  }
}

async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("web_fetch 只允许 http/https URL");
  }
  if (url.username || url.password) throw new Error("URL 不允许包含认证信息");
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname, family: isIP(url.hostname) }]
    : await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("URL 指向本机或私有网络地址");
  }
}

function isPrivateAddress(value: string): boolean {
  const normalized = value.toLowerCase();
  if (normalized === "::1" || normalized === "::" || normalized.startsWith("fe80:")) return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const ipv4 = mapped ?? (isIP(normalized) === 4 ? normalized : undefined);
  if (!ipv4) return false;
  const parts = ipv4.split(".").map(Number);
  const [a = 0, b = 0] = parts;
  return a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || a >= 224;
}

async function limitResponse(response: Response, maxBytes: number, finalUrl: string): Promise<Response> {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw responseTooLarge(maxBytes);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  const headers = new Headers(response.headers);
  headers.set("x-kindergarten-final-url", finalUrl);
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function responseTooLarge(maxBytes: number): ToolExecutionError {
  return new ToolExecutionError(
    "web_response_too_large",
    "resource_limit",
    `网页响应超过 ${maxBytes} 字节资源上限`,
    false,
    { maxBytes },
  );
}

function parseBing(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const itemPattern = /<li[^>]+class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  for (const itemMatch of html.matchAll(itemPattern)) {
    const item = itemMatch[1] ?? "";
    const match = item.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!match) continue;
    const href = decodeHtml(match[1] ?? "");
    const title = htmlToText(match[2] ?? "");
    if (!href || !title) continue;
    const snippetMatch = item.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    results.push({ title, url: href, snippet: htmlToText(snippetMatch?.[1] ?? "") });
  }
  return results;
}

function htmlToText(value: string): string {
  return decodeHtml(value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
