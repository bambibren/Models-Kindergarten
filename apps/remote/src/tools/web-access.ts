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

const DEFAULT_EXA_MCP_ENDPOINT = "https://mcp.exa.ai/mcp";
const EXA_SEARCH_TOOL = "web_search_exa";
const EXA_CONTEXT_MAX_CHARACTERS = 3_000;
const EXA_SNIPPET_MAX_CHARACTERS = 800;

/** 无密钥 Exa MCP 搜索用于本地演示；所有目标 URL 都先做私网与响应大小校验。 */
export class WebAccess implements WebToolClient {
  private readonly circuits = new DependencyCircuits();

  constructor(
    private readonly searchEndpoint = process.env.WEB_SEARCH_ENDPOINT ?? DEFAULT_EXA_MCP_ENDPOINT,
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
    const resultLimit = clamp(
      maxResults,
      PRODUCT_CONFIG.tools.web.minSearchResults,
      PRODUCT_CONFIG.tools.web.maxSearchResults,
    );
    const url = new URL(this.searchEndpoint);
    const response = await this.request(url, signal, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "user-agent": "Models-Kindergarten/0.3",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: EXA_SEARCH_TOOL,
          arguments: {
            query,
            type: "fast",
            numResults: resultLimit,
            livecrawl: "fallback",
            contextMaxCharacters: EXA_CONTEXT_MAX_CHARACTERS,
          },
        },
      }),
    });
    const body = await response.text();
    const parsed = parseExaResponse(body);
    if (parsed.error) {
      throw new ToolExecutionError(
        "web_search_upstream_error",
        "network",
        `Exa 搜索服务失败: ${parsed.error.message}`,
        true,
        { provider: "exa", code: parsed.error.code },
      );
    }
    if (!parsed.recognized) {
      throw new ToolExecutionError(
        "web_search_invalid_response",
        "execution",
        "Exa 搜索服务返回了无法解析的响应",
        true,
        { provider: "exa" },
      );
    }
    return parsed.results.slice(0, resultLimit);
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

interface ExaResponse {
  recognized: boolean;
  results: WebSearchResult[];
  error?: { code?: number; message: string };
}

function parseExaResponse(body: string): ExaResponse {
  const payloads = parseExaPayloads(body);
  if (payloads.length === 0) return { recognized: false, results: [] };

  const results: WebSearchResult[] = [];
  const seenUrls = new Set<string>();
  let recognized = false;
  for (const payload of payloads) {
    if (!isRecord(payload)) continue;
    const error = payload.error;
    if (isRecord(error) && typeof error.message === "string") {
      return {
        recognized: true,
        results: [],
        error: {
          ...(typeof error.code === "number" ? { code: error.code } : {}),
          message: error.message,
        },
      };
    }
    const result = payload.result;
    if (!isRecord(result) || !Array.isArray(result.content)) continue;
    recognized = true;
    for (const item of result.content) {
      if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") continue;
      for (const candidate of parseExaSearchText(item.text)) {
        if (seenUrls.has(candidate.url)) continue;
        seenUrls.add(candidate.url);
        results.push(candidate);
      }
    }
  }
  return { recognized, results };
}

function parseExaPayloads(body: string): unknown[] {
  const payloads: unknown[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const value = line.slice("data:".length).trim();
    if (!value || value === "[DONE]") continue;
    try {
      payloads.push(JSON.parse(value));
    } catch {
      // 单个 SSE 事件损坏时继续检查后续事件；全部损坏会由上层报告协议错误。
    }
  }
  if (payloads.length > 0) return payloads;

  try {
    return [JSON.parse(body)];
  } catch {
    return [];
  }
}

function parseExaSearchText(text: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  for (const block of text.split(/\r?\n---\r?\n/g)) {
    const urlValue = block.match(/^URL:\s*(\S+)\s*$/m)?.[1];
    if (!urlValue || !isPublicResultUrl(urlValue)) continue;
    const title = block.match(/^Title:\s*(.+?)\s*$/m)?.[1]?.trim() || urlValue;
    const detail = block.match(/^(?:Highlights|Summary|Content|Text):\s*([\s\S]*)$/mi)?.[1] ?? "";
    results.push({
      title,
      url: urlValue,
      snippet: normalizeExaSnippet(detail),
    });
  }
  return results;
}

function isPublicResultUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeExaSnippet(value: string): string {
  return value
    .replace(/\[([^\]]+)]\([^\s)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, EXA_SNIPPET_MAX_CHARACTERS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
