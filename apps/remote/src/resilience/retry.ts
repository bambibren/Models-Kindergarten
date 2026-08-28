/** 描述「RetryPolicy」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface RetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
  shouldRetry(error: unknown): boolean;
}

/** 重试只包围单个无副作用依赖调用，不跨越模型 Tool Loop。 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  policy: RetryPolicy,
  signal?: AbortSignal,
): Promise<T> {
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      return await operation();
    } catch (error) {
      if (attempt >= policy.maxAttempts || !policy.shouldRetry(error)) throw error;
      const base = Math.min(
        policy.maxDelayMs,
        policy.initialDelayMs * 2 ** (attempt - 1),
      );
      const delay = policy.jitter ? Math.round(base * (0.5 + Math.random() * 0.5)) : base;
      await wait(delay, signal);
    }
  }
}

/** 执行「wait」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(/** 完成当前异步桥接，并保证每条分支只结算一次。 */
(resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("已取消", "AbortError"));
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", cancel, { once: true });
    /** 完成当前异步桥接，并保证每条分支只结算一次。 */
function done(): void {
      signal?.removeEventListener("abort", cancel);
      resolve();
    }
    /** 完成当前异步桥接，并保证每条分支只结算一次。 */
function cancel(): void {
      clearTimeout(timer);
      reject(new DOMException("已取消", "AbortError"));
    }
  });
}
