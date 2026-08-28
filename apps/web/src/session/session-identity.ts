import { ControlApiError } from "../api/control-api.js";

/** 描述「SessionAgentAvailability」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type SessionAgentAvailability = "loading" | "available" | "missing";

export const deletedAgentMessage = "该会话绑定的 Agent 已删除，不能继续对话";

/** 判断「isMissingAgentError」对应条件，只返回判定结果且不修改输入状态。 */
export function isMissingAgentError(error: unknown): boolean {
  return error instanceof ControlApiError && error.code === "NOT_FOUND";
}

/** 执行「projectSessionAvailability」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function projectSessionAvailability(
  connected: boolean,
  hasSession: boolean,
  agent: SessionAgentAvailability,
): { navigationEnabled: boolean; promptEnabled: boolean } {
  const sessionReady = connected && hasSession;
  return {
    navigationEnabled: sessionReady,
    promptEnabled: sessionReady && agent === "available",
  };
}
