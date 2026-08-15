import { ApiProblemError } from "./api-problem.js";

export class OriginPolicy {
  private readonly allowed: Set<string>;

  constructor(origins: string[]) {
    this.allowed = new Set(origins.map(normalizeOrigin));
  }

  assertWriteAllowed(request: Request): string | undefined {
    if (isReadMethod(request.method)) return this.allowedOrigin(request);
    const origin = request.headers.get("origin");
    if (!origin || origin === "null" || !this.allowed.has(origin)) {
      throw new ApiProblemError(403, "ORIGIN_NOT_ALLOWED", "写请求的 Origin 不在允许列表中", false);
    }
    return origin;
  }

  allowedOrigin(request: Request): string | undefined {
    const origin = request.headers.get("origin");
    return origin && this.allowed.has(origin) ? origin : undefined;
  }
}

function normalizeOrigin(value: string): string {
  const parsed = new URL(value);
  if (parsed.origin === "null" || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`无效 Control API Origin: ${value}`);
  }
  return parsed.origin;
}

function isReadMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}
