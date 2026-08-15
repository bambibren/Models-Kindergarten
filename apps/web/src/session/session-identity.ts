import { ControlApiError } from "../api/control-api.js";

export type SessionAgentAvailability = "loading" | "available" | "missing";

export const deletedAgentMessage = "该会话绑定的 Agent 已删除，不能继续对话";

export function isMissingAgentError(error: unknown): boolean {
  return error instanceof ControlApiError && error.code === "NOT_FOUND";
}

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
