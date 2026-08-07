/**
 * RunFailure 只表达一个事实：当前 Prompt Turn 已经无法继续。
 * Provider、Tool 等模块保留自己的领域错误；跨到 ACP 前只暴露可读消息，
 * 原始 cause 留在 Remote，供日志和调试使用。
 */
export class RunFailure extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RunFailure";
  }
}

/**
 * 这是执行边界上的纯转换，不负责分类、重试或 UI 决策。
 * 已规范化的错误直接复用，避免多层包装掩盖最初的失败原因。
 */
export function toRunFailure(cause: unknown): RunFailure {
  if (cause instanceof RunFailure) return cause;
  return new RunFailure(errorMessage(cause), { cause });
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim()) return cause.message;
  if (typeof cause === "string" && cause.trim()) return cause;
  return "Agent Runtime 执行失败";
}
