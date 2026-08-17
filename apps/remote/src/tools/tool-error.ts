import type { ToolErrorCategory, ToolResult } from "./tool-registry.js";

interface ToolExecutionErrorOptions extends ErrorOptions {
  effects?: ToolResult["effects"];
}

/** Tool Handler 的结构化失败；ToolRuntime 只读字段，不猜测 stderr 文案。 */
export class ToolExecutionError extends Error {
  readonly effects?: ToolResult["effects"];

  constructor(
    readonly code: string,
    readonly category: ToolErrorCategory,
    message: string,
    readonly retryable: boolean,
    readonly rawOutput?: unknown,
    options?: ToolExecutionErrorOptions,
  ) {
    super(message, options);
    this.name = "ToolExecutionError";
    this.effects = options?.effects;
  }
}
