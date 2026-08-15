import { randomUUID } from "node:crypto";
import { ApiProblemError, problemResponse } from "./api-problem.js";
import { ControlRouter } from "./control-router.js";
import { localPrincipal } from "./local-principal.js";
import { OriginPolicy } from "./origin-policy.js";

export interface ControlApiOptions {
  allowedOrigins: string[];
  maxJsonBytes?: number;
}

export class ControlApi {
  readonly router = new ControlRouter();
  private readonly origins: OriginPolicy;
  private readonly maxJsonBytes: number;

  constructor(options: ControlApiOptions) {
    this.origins = new OriginPolicy(options.allowedOrigins);
    this.maxJsonBytes = options.maxJsonBytes ?? 256 * 1024;
  }

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
      let jsonLoaded = false;
      let jsonValue: unknown;
      const data = await matched.handler({
        request,
        url,
        params: matched.params,
        requestId,
        principal: localPrincipal,
        json: async () => {
          if (jsonLoaded) return jsonValue;
          jsonLoaded = true;
          jsonValue = await readJson(request, this.maxJsonBytes);
          return jsonValue;
        },
      });
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

async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new ApiProblemError(400, "VALIDATION_FAILED", "写请求必须使用 application/json", false);
  }
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw tooLarge();
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new ApiProblemError(400, "VALIDATION_FAILED", "JSON 格式无效", false);
  }
}

function tooLarge(): ApiProblemError {
  return new ApiProblemError(413, "VALIDATION_FAILED", "JSON 请求体超过大小限制", false);
}

function cors(origin: string | undefined): Record<string, string> {
  return origin ? { "access-control-allow-origin": origin, vary: "origin" } : {};
}
