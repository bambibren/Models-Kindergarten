import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";

/** 描述「ResolvedHttpAddress」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ResolvedHttpAddress {
  address: string;
  family: 4 | 6;
}

/**
 * 安全策略一次解析产生的不可变连接票据。url 是策略实际审核的完整 URL，
 * addresses 是该次审核通过且唯一允许本次 socket 使用的地址集合。
 */
export interface ResolvedHttpEndpoint {
  url: URL;
  addresses: readonly ResolvedHttpAddress[];
}

/** 描述「HttpEndpointResolver」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type HttpEndpointResolver = (
  url: URL,
) => ResolvedHttpEndpoint | Promise<ResolvedHttpEndpoint>;

/** 描述「OutboundHttpRequest」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface OutboundHttpRequest {
  method: string;
  headers?: Readonly<Record<string, string>>;
  /** 模型 wire API 当前统一发送 JSON 文本；二进制上传应使用独立受控通道。 */
  body?: string;
  signal?: AbortSignal;
}

/** 与具体模型 wire API 无关；Responses、ChatCompletions、Anthropic 均可复用。 */
export interface OutboundHttpTransport {
  request(url: URL, request: OutboundHttpRequest): Promise<Response>;
}

/** 只供不需要地址约束的本地 fixture；生产自定义端点应使用 PinnedHttpTransport。 */
export class GlobalFetchHttpTransport implements OutboundHttpTransport {
  /** 执行「request」主流程，传播取消与失败并在结束时清理临时资源。 */
request(url: URL, request: OutboundHttpRequest): Promise<Response> {
    return fetch(url, {
      method: request.method,
      ...(request.headers ? { headers: { ...request.headers } } : {}),
      ...(request.body !== undefined ? { body: request.body } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
      redirect: "manual",
    });
  }
}

/**
 * 将安全策略审核过的地址直接注入 node:http(s) 的 socket lookup。
 * 原始 hostname 仍用于 Host 与 TLS SNI/证书校验，但系统 DNS 不会再次参与。
 * 每次请求禁用共享 Agent，避免复用其他解析票据建立的旧 socket。
 */
export class PinnedHttpTransport implements OutboundHttpTransport {
  /** 初始化「PinnedHttpTransport」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(private readonly resolveEndpoint: HttpEndpointResolver) {}

  /** 执行「request」主流程，传播取消与失败并在结束时清理临时资源。 */
async request(url: URL, request: OutboundHttpRequest): Promise<Response> {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new TypeError("PinnedHttpTransport 只支持 HTTP(S) URL");
    }
    const ticket = await this.resolveEndpoint(new URL(url));
    assertTicketMatches(url, ticket);
    if (request.signal?.aborted) throw request.signal.reason;

    return requestWithPinnedLookup(ticket, request);
  }
}

/** 执行「requestWithPinnedLookup」主流程，传播取消与失败并在结束时清理临时资源。 */
function requestWithPinnedLookup(
  ticket: ResolvedHttpEndpoint,
  outbound: OutboundHttpRequest,
): Promise<Response> {
  const requestImpl = ticket.url.protocol === "https:" ? httpsRequest : httpRequest;
  const lookup = pinnedLookup(ticket);

  return new Promise<Response>(/** 完成当前异步桥接，并保证每条分支只结算一次。 */
(resolve, reject) => {
    const request = requestImpl(ticket.url, {
      method: outbound.method,
      ...(outbound.headers ? { headers: { ...outbound.headers } } : {}),
      ...(outbound.signal ? { signal: outbound.signal } : {}),
      lookup,
      // 连接不得跨安全策略解析票据复用，否则旧 socket 会绕过本次地址审核。
      agent: false,
    }, /** 执行「request」主流程，传播取消与失败并在结束时清理临时资源。 */
(incoming) => {
      const status = incoming.statusCode;
      if (status === undefined) {
        incoming.destroy();
        reject(new Error("HTTP 响应缺少状态码"));
        return;
      }
      const headers = responseHeaders(incoming.rawHeaders);
      const bodyForbidden = status === 101 || status === 204 || status === 205 || status === 304;
      if (bodyForbidden) incoming.resume();
      resolve(new Response(
        bodyForbidden
          ? null
          : Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>,
        {
          status,
          ...(incoming.statusMessage ? { statusText: incoming.statusMessage } : {}),
          headers,
        },
      ));
    });
    request.once("error", reject);
    request.end(outbound.body);
  });
}

/** 执行「pinnedLookup」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function pinnedLookup(ticket: ResolvedHttpEndpoint): LookupFunction {
  const hostname = canonicalHostname(ticket.url.hostname);
  const addresses = ticket.addresses.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
({ address, family }) => ({ address, family }));
  return /** 执行「pinnedLookup」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */ (requestedHostname, options, callback) => {
    if (canonicalHostname(requestedHostname) !== hostname) {
      callback(lookupError("已审核 URL 与 socket hostname 不一致"), "", 0);
      return;
    }
    const family = options.family === 4 || options.family === 6 ? options.family : undefined;
    const eligible = family
      ? addresses.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(address) => address.family === family)
      : addresses;
    if (eligible.length === 0) {
      callback(lookupError("已审核地址不支持请求的 IP family"), "", 0);
      return;
    }
    if (options.all) {
      callback(null, eligible.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(address) => ({ ...address })));
      return;
    }
    const selected = eligible[0];
    if (!selected) {
      callback(lookupError("已审核地址为空"), "", 0);
      return;
    }
    callback(null, selected.address, selected.family);
  };
}

/** 校验并规范化「assertTicketMatches」输入，非法数据直接返回明确错误。 */
function assertTicketMatches(requested: URL, ticket: ResolvedHttpEndpoint): void {
  if (!(ticket.url instanceof URL) || ticket.url.href !== requested.href) {
    throw new Error("端点解析票据与请求 URL 不一致");
  }
  if (ticket.addresses.length === 0) {
    throw new Error("端点解析票据没有可用地址");
  }
  for (const item of ticket.addresses) {
    if (isIP(item.address) !== item.family) {
      throw new Error("端点解析票据包含无效 IP 地址");
    }
  }
}

/** 执行「responseHeaders」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function responseHeaders(rawHeaders: readonly string[]): Headers {
  const headers = new Headers();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) headers.append(name, value);
  }
  return headers;
}

/** 判断「canonicalHostname」对应条件，只返回判定结果且不修改输入状态。 */
function canonicalHostname(value: string): string {
  const withoutBrackets = value.startsWith("[") && value.endsWith("]")
    ? value.slice(1, -1)
    : value;
  return withoutBrackets.replace(/\.$/, "").toLowerCase();
}

/** 执行「lookupError」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function lookupError(message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = "EAI_FAIL";
  return error;
}
