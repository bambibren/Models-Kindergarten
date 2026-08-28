import { ApiProblemError } from "./api-problem.js";

/** 描述「OriginPolicy」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export class OriginPolicy {
  private readonly allowed: Set<string>;

  /** 初始化「OriginPolicy」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(origins: string[]) {
    this.allowed = new Set(origins.map(normalizeOrigin));
  }

  /** 校验并规范化「assertWriteAllowed」输入，非法数据直接返回明确错误。 */
assertWriteAllowed(request: Request): string | undefined {
    if (isReadMethod(request.method)) return this.allowedOrigin(request);
    const origin = request.headers.get("origin");
    if (!origin || origin === "null" || !this.allowed.has(origin)) {
      throw new ApiProblemError(403, "ORIGIN_NOT_ALLOWED", "写请求的 Origin 不在允许列表中", false);
    }
    return origin;
  }

  /** 执行「allowedOrigin」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
allowedOrigin(request: Request): string | undefined {
    const origin = request.headers.get("origin");
    return origin && this.allowed.has(origin) ? origin : undefined;
  }
}

/** 校验并规范化「normalizeOrigin」输入，非法数据直接返回明确错误。 */
function normalizeOrigin(value: string): string {
  const parsed = new URL(value);
  if (parsed.origin === "null" || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`无效 Control API Origin: ${value}`);
  }
  return parsed.origin;
}

/** 判断「isReadMethod」对应条件，只返回判定结果且不修改输入状态。 */
function isReadMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}
