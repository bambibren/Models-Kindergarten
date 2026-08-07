import type { ToolErrorCategory } from "./tool-registry.js";

/** Tool Handler 的结构化失败；ToolRuntime 只读字段，不猜测 stderr 文案。 */
export class ToolExecutionError extends Error {
  constructor(
    readonly code: string,
    readonly category: ToolErrorCategory,
    message: string,
    readonly retryable: boolean,
    readonly rawOutput?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ToolExecutionError";
  }
}
