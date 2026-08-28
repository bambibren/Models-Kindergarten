import type { EntryCollection } from "./chat-types.js";

/** 描述「SessionTokenUsageTotal」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface SessionTokenUsageTotal {
  turns: number;
  modelRequests: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
}

/** cached/reasoning 是输入/输出的子集，只汇总为明细，绝不重复加入顶层总量。 */
export function selectSessionTokenUsage(
  ...collections: EntryCollection[]
): SessionTokenUsageTotal | null {
  const usages = collections.flatMap(/** 执行「usages」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(collection) =>
    collection.order.flatMap(/** 执行「usages」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(id) => {
      const entry = collection.byId[id];
      return entry?.type === "token_usage" ? [entry.usage] : [];
    }),
  );
  if (usages.length === 0) return null;
  return {
    turns: usages.length,
    modelRequests: usages.reduce(/** 把当前元素归并到有限累加状态，避免额外复制完整集合。 */
(total, usage) => total + usage.modelRequests, 0),
    ...sumReported(usages, "inputTokens"),
    ...sumReported(usages, "outputTokens"),
    ...sumReported(usages, "cachedInputTokens"),
    ...sumReported(usages, "reasoningOutputTokens"),
  };
}

/** 汇总「sumReported」对应指标，保持缺失字段语义且不重复计算同一来源。 */
function sumReported<
  K extends "inputTokens" | "outputTokens" | "cachedInputTokens" | "reasoningOutputTokens",
>(
  usages: Array<{ [P in K]?: number }>,
  key: K,
): Partial<Record<K, number>> {
  const values = usages.flatMap(/** 执行「values」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(usage) =>
    typeof usage[key] === "number" ? [usage[key] as number] : [],
  );
  return values.length > 0
    ? { [key]: values.reduce(/** 把当前元素归并到有限累加状态，避免额外复制完整集合。 */
(total, value) => total + value, 0) } as Partial<Record<K, number>>
    : {};
}
