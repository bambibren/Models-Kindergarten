/** Provider 边界抛出的结构化错误，避免 Runner 解析自然语言错误文本。 */
export interface ModelProviderErrorOptions extends ErrorOptions {
  httpStatus?: number;
  providerCode?: string;
  retryAfterMs?: number;
}

export class ModelProviderError extends Error {
  readonly httpStatus: number | undefined;
  readonly providerCode: string | undefined;
  readonly retryAfterMs: number | undefined;

  /** 初始化「ModelProviderError」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(
    readonly code: "dependency_unavailable" | "model_request_failed" | "invalid_model_response",
    message: string,
    readonly retryable: boolean,
    options?: ModelProviderErrorOptions,
  ) {
    super(message, options);
    this.name = "ModelProviderError";
    this.httpStatus = options?.httpStatus;
    this.providerCode = options?.providerCode;
    this.retryAfterMs = options?.retryAfterMs;
  }
}

/** 解析 HTTP Retry-After；支持秒数和 HTTP-date，非法或已过期值不参与重试等待。 */
export function retryAfterMilliseconds(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return undefined;
  return at > now ? at - now : undefined;
}

/** 408、429 与 5xx 属于请求级瞬时失败；认证、权限和参数类 4xx 不自动重试。 */
export function isRetryableModelHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
