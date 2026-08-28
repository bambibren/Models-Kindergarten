import type { ContextWindowUsageState } from "@kindergarten/contracts";
import type { EntryCollection } from "./chat-types.js";

/** 描述「ContextWindowUsageLevel」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ContextWindowUsageLevel = "normal" | "warning" | "critical";

/** 描述「ContextWindowUsageView」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ContextWindowUsageView {
  afterTurnId: string;
  estimatedTokens: number;
  windowTokens: number;
  remainingTokens: number;
  percent: number;
  ringPercent: number;
  level: ContextWindowUsageLevel;
}

/** 执行「selectContextWindowUsage」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function selectContextWindowUsage(
  history: EntryCollection,
  streaming?: EntryCollection,
): ContextWindowUsageView | null {
  let latest: ContextWindowUsageState | undefined;
  for (const collection of streaming ? [history, streaming] : [history]) {
    for (const id of collection.order) {
      const entry = collection.byId[id];
      if (entry?.type === "context_window_usage") latest = entry.state;
    }
  }
  return latest ? projectContextWindowUsage(latest) : null;
}

/** 执行「projectContextWindowUsage」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function projectContextWindowUsage(
  state: ContextWindowUsageState,
): ContextWindowUsageView | null {
  if (state.status === "unavailable") return null;
  const percent = state.estimatedTokens / state.windowTokens * 100;
  return {
    afterTurnId: state.afterTurnId,
    estimatedTokens: state.estimatedTokens,
    windowTokens: state.windowTokens,
    remainingTokens: Math.max(0, state.windowTokens - state.estimatedTokens),
    percent,
    ringPercent: Math.min(100, Math.max(0, percent)),
    level: percent >= 80 ? "critical" : percent >= 50 ? "warning" : "normal",
  };
}

/** 执行「formatContextPercent」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function formatContextPercent(percent: number): string {
  if (percent > 0 && percent < 0.1) return "<0.1%";
  if (percent > 100) return ">100%";
  return `${percent.toFixed(1)}%`;
}

/** 执行「formatContextTokens」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function formatContextTokens(tokens: number): string {
  return new Intl.NumberFormat("zh-CN").format(tokens);
}
