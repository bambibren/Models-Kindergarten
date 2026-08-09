import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_MCP_RESPONSE_BYTES = 4 * 1024 * 1024;

/** 创建 Transport 专用 fetch，使 OAuth 元数据和每次重定向也经过同一网络策略。 */
export function createMcpFetch(allowPrivateNetwork: boolean): typeof fetch {
  return async (input, init) => {
    const url = requestUrl(input);
    await assertMcpUrl(url, allowPrivateNetwork);
    const response = await fetch(input, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error("MCP HTTP 不自动跟随重定向；请配置最终 HTTPS 地址");
    }
    return limitResponse(response, MAX_MCP_RESPONSE_BYTES);
  };
}

export async function assertMcpUrl(url: URL, allowPrivateNetwork: boolean): Promise<void> {
  if (url.username || url.password) throw new Error("MCP URL 不允许包含认证信息");
  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("远程 MCP 只允许 HTTPS；本机 loopback 开发地址可使用 HTTP");
  }
  if (allowPrivateNetwork || loopback) return;
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("MCP URL 指向本机、私有网络或保留地址");
  }
}

function requestUrl(input: string | URL | Request): URL {
  if (input instanceof URL) return input;
  if (typeof input === "string") return new URL(input);
  return new URL(input.url);
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function isPrivateAddress(value: string): boolean {
  const normalized = value.toLowerCase();
  if (normalized === "::1" || normalized === "::" || normalized.startsWith("fe80:")) return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const ipv4 = mapped ?? (isIP(normalized) === 4 ? normalized : undefined);
  if (!ipv4) return false;
  const [a = 0, b = 0] = ipv4.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || a >= 224;
}

function limitResponse(response: Response, maxBytes: number): Response {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    void response.body?.cancel();
    throw new Error(`MCP 响应超过 ${maxBytes} 字节限制`);
  }
  if (!response.body) return response;
  let total = 0;
  const limited = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        controller.error(new Error(`MCP 响应超过 ${maxBytes} 字节限制`));
        return;
      }
      controller.enqueue(chunk);
    },
  }));
  return new Response(limited, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
