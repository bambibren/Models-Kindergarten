import type { ReasoningProfile } from "@kindergarten/contracts";

export const demoSessionReasoningPrefix = "models-kindergarten.demo-session-reasoning.";

/** 描述「DemoReasoningStorage」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface DemoReasoningStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 读取「loadDemoSessionReasoning」所需数据，并遵守作用域、分页与容量边界。 */
export function loadDemoSessionReasoning(storage: Pick<DemoReasoningStorage, "getItem">, sessionId: string): ReasoningProfile {
  const value = storage.getItem(key(sessionId));
  return value === "fast" || value === "balanced" || value === "deep" || value === "max" ? value : "auto";
}

/** 更新「saveDemoSessionReasoning」对应状态，并保持写入顺序、原子性与容量约束。 */
export function saveDemoSessionReasoning(storage: DemoReasoningStorage, sessionId: string, profile: ReasoningProfile): void {
  if (profile === "auto") storage.removeItem(key(sessionId));
  else storage.setItem(key(sessionId), profile);
}

/** 执行「key」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function key(sessionId: string): string {
  return `${demoSessionReasoningPrefix}${sessionId}`;
}
