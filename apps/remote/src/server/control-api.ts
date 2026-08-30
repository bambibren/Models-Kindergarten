import { randomUUID } from "node:crypto";
import { ApiProblemError, problemResponse } from "./api-problem.js";
import { ControlRouter } from "./control-router.js";
import { localPrincipal } from "./local-principal.js";
import { OriginPolicy } from "./origin-policy.js";
import { PRODUCT_CONFIG, type Principal } from "@kindergarten/contracts";

/** 描述「ControlApiOptions」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ControlApiOptions {
  allowedOrigins: string[];
  maxJsonBytes?: number;
  maxConcurrentRequests?: number;
  resolvePrincipal?: (request: Request) => Promise<Principal | undefined>;
  publicPaths?: string[];
}

/** 描述「ControlApi」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export class ControlApi {
  readonly router = new ControlRouter();
  private readonly origins: OriginPolicy;
  private readonly maxJsonBytes: number;
  private readonly maxConcurrentRequests: number;
  /** 只统计已经匹配路由且正在执行的 Handler；请求结束后在 finally 中归还名额。 */
  private activeRequests = 0;

  /** 初始化「ControlApi」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(private readonly options: ControlApiOptions) {
    this.origins = new OriginPolicy(options.allowedOrigins);
    this.maxJsonBytes = options.maxJsonBytes ?? 256 * 1024;
    this.maxConcurrentRequests = options.maxConcurrentRequests ?? PRODUCT_CONFIG.server.maxConcurrentControlRequests;
    if (!Number.isInteger(this.maxConcurrentRequests) || this.maxConcurrentRequests < 1) {
      throw new Error("Control API 并发上限必须是正整数");
    }
  }

  /** 读取「fetch」所需数据，并遵守作用域、分页与容量边界。 */
async fetch(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    const prefix = "/api/control/v1";
    if (!url.pathname.startsWith(prefix)) return undefined;
    const requestId = randomUUID();
    let origin: string | undefined;
    try {
      origin = this.origins.assertWriteAllowed(request);
      const path = url.pathname.slice(prefix.length) || "/";
      if (request.method === "OPTIONS") return this.preflight(path, request, requestId);
      const matched = this.router.match(request.method, path);
      if (!matched) {
        const allowed = this.router.allowedMethods(path);
        if (allowed.length > 0) {
          return problemResponse(
            new ApiProblemError(405, "VALIDATION_FAILED", "该资源不支持此方法", false),
            requestId,
            { ...cors(origin), allow: allowed.join(", ") },
          );
        }
        return problemResponse(new ApiProblemError(404, "NOT_FOUND", "Control API 路由不存在", false), requestId, cors(origin));
      }
      const principal = this.options.publicPaths?.includes(path)
        ? localPrincipal
        : this.options.resolvePrincipal
          ? await this.options.resolvePrincipal(request)
          : localPrincipal;
      if (!principal) {
        return problemResponse(
          new ApiProblemError(401, "AUTHENTICATION_REQUIRED", "请先登录", false),
          requestId,
          cors(origin),
        );
      }
      let jsonLoaded = false;
      let jsonValue: unknown;
      if (this.activeRequests >= this.maxConcurrentRequests) {
        return problemResponse(
          new ApiProblemError(503, "REMOTE_BUSY", "Control API 正在处理的请求已达到容量上限", true),
          requestId,
          cors(origin),
        );
      }
      this.activeRequests += 1;
      let data: unknown;
      try {
        data = await matched.handler({
          request,
          url,
          params: matched.params,
          requestId,
          principal,
          json: /** 请求体只解析一次，并继续服从边读边限流的字节上限。 */
async () => {
            if (jsonLoaded) return jsonValue;
            jsonLoaded = true;
            jsonValue = await readJson(request, this.maxJsonBytes);
            return jsonValue;
          },
        });
      } finally {
        // 成功、业务失败和取消都必须归还名额，不能把异常请求永久计入容量。
        this.activeRequests -= 1;
      }
      if (data instanceof Response) {
        const headers = new Headers(data.headers);
        headers.set("x-request-id", requestId);
        for (const [key, value] of Object.entries(cors(origin))) headers.set(key, value);
        return new Response(data.body, { status: data.status, statusText: data.statusText, headers });
      }
      return new Response(JSON.stringify({ data: data ?? null, requestId }), {
        status: request.method === "POST" ? 201 : 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-request-id": requestId,
          ...cors(origin),
        },
      });
    } catch (error) {
      if (!(error instanceof ApiProblemError)) console.error("Control API error", error);
      return problemResponse(error, requestId, cors(origin));
    }
  }

  /** 执行「preflight」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
private preflight(path: string, request: Request, requestId: string): Response {
    const origin = this.origins.allowedOrigin(request);
    if (!origin) return problemResponse(new ApiProblemError(403, "ORIGIN_NOT_ALLOWED", "Origin 不在允许列表中", false), requestId);
    const allowed = this.router.allowedMethods(path);
    if (allowed.length === 0) return problemResponse(new ApiProblemError(404, "NOT_FOUND", "Control API 路由不存在", false), requestId, cors(origin));
    return new Response(null, {
      status: 204,
      headers: {
        ...cors(origin),
        "access-control-allow-methods": [...allowed, "OPTIONS"].join(", "),
        "access-control-allow-headers": "content-type,idempotency-key",
        "x-request-id": requestId,
      },
    });
  }
}

/** 读取「readJson」所需数据，并遵守作用域、分页与容量边界。 */
async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new ApiProblemError(400, "VALIDATION_FAILED", "写请求必须使用 application/json", false);
  }
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  const bytes = await readAtMost(request.body, maxBytes);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new ApiProblemError(400, "VALIDATION_FAILED", "JSON 格式无效", false);
  }
}

/**
 * 对分块传输也在读取过程中执行上限，避免缺少 Content-Length 时先把任意大小的
 * 请求完整装入内存，随后才发现超限。
 */
async function readAtMost(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** 根据已校验输入构建「tooLarge」结果，不额外持有调用方的大对象。 */
function tooLarge(): ApiProblemError {
  return new ApiProblemError(413, "VALIDATION_FAILED", "JSON 请求体超过大小限制", false);
}

/** 执行「cors」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function cors(origin: string | undefined): Record<string, string> {
  return origin ? { "access-control-allow-origin": origin, vary: "origin" } : {};
}
