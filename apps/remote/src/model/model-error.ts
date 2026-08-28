/** Provider 边界抛出的结构化错误，避免 Runner 解析自然语言错误文本。 */
export class ModelProviderError extends Error {
  /** 初始化「ModelProviderError」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(
    readonly code: "dependency_unavailable" | "model_request_failed" | "invalid_model_response",
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ModelProviderError";
  }
}
