import type { PublicErrorCode } from "@kindergarten/contracts";

export class ApiProblemError extends Error {
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

function titleFor(status: number): string {
  if (status === 400) return "请求无效";
  if (status === 403) return "请求被拒绝";
  if (status === 404) return "资源不存在";
  if (status === 405) return "方法不允许";
  if (status === 409) return "资源冲突";
  if (status === 413) return "请求体过大";
  return "服务错误";
}
