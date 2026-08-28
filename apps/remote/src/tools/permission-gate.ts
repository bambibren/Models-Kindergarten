import type { PreparedToolCall } from "./tool-registry.js";

/** 描述「PermissionRequester」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface PermissionRequester {
  requestPermission(call: PreparedToolCall): Promise<boolean>;
}

/** Remote 决定授权策略，具体 UI 由 ACP Client 实现。 */
/** 描述「PermissionGate」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export class PermissionGate {
  /** 执行「authorize」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async authorize(
    call: PreparedToolCall,
    requester: PermissionRequester,
  ): Promise<boolean> {
    if (call.permission === "allow") return true;
    if (call.permission === "deny") return false;
    return requester.requestPermission(call);
  }
}
