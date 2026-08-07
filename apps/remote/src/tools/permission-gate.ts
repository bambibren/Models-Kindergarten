import type { PreparedToolCall } from "./tool-registry.js";

export interface PermissionRequester {
  requestPermission(call: PreparedToolCall): Promise<boolean>;
}

/** Remote 决定授权策略，具体 UI 由 ACP Client 实现。 */
export class PermissionGate {
  async authorize(
    call: PreparedToolCall,
    requester: PermissionRequester,
  ): Promise<boolean> {
    if (call.permission === "allow") return true;
    if (call.permission === "deny") return false;
    return requester.requestPermission(call);
  }
}
