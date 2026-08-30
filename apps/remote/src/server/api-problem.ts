import type { PublicErrorCode } from "@kindergarten/contracts";

/** 描述「ApiProblemError」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export class ApiProblemError extends Error {
  /** 初始化「ApiProblemError」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(
    readonly status: number,
    readonly code: PublicErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly fieldErrors?: Array<{ path: string; message: string }>,
  ) {
    super(message);
  }
}

/** 执行「problemResponse」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function problemResponse(error: unknown, requestId: string, headers: HeadersInit = {}): Response {
  const problem = error instanceof ApiProblemError
    ? error
    : new ApiProblemError(500, "INTERNAL_ERROR", "服务内部错误", true);
  return new Response(JSON.stringify({
    type: `https://models-kindergarten.local/problems/${problem.code.toLowerCase()}`,
    title: titleFor(problem.status),
    status: problem.status,
    detail: problem.message,
    code: problem.code,
    requestId,
    retryable: problem.retryable,
    ...(problem.fieldErrors ? { fieldErrors: problem.fieldErrors } : {}),
  }), {
    status: problem.status,
    headers: {
      "content-type": "application/problem+json; charset=utf-8",
      "x-request-id": requestId,
      ...headers,
    },
  });
}

/** 执行「titleFor」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function titleFor(status: number): string {
  if (status === 400) return "请求无效";
  if (status === 401) return "需要登录";
  if (status === 403) return "请求被拒绝";
  if (status === 404) return "资源不存在";
  if (status === 405) return "方法不允许";
  if (status === 409) return "资源冲突";
  if (status === 413) return "请求体过大";
  return "服务错误";
}
