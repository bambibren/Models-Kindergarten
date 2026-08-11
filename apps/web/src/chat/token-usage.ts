import type { EntryCollection } from "./chat-types.js";

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
  const usages = collections.flatMap((collection) =>
    collection.order.flatMap((id) => {
      const entry = collection.byId[id];
      return entry?.type === "token_usage" ? [entry.usage] : [];
    }),
  );
  if (usages.length === 0) return null;
  return {
    turns: usages.length,
    modelRequests: usages.reduce((total, usage) => total + usage.modelRequests, 0),
    ...sumReported(usages, "inputTokens"),
    ...sumReported(usages, "outputTokens"),
    ...sumReported(usages, "cachedInputTokens"),
    ...sumReported(usages, "reasoningOutputTokens"),
  };
}

function sumReported<
  K extends "inputTokens" | "outputTokens" | "cachedInputTokens" | "reasoningOutputTokens",
>(
  usages: Array<{ [P in K]?: number }>,
  key: K,
): Partial<Record<K, number>> {
  const values = usages.flatMap((usage) =>
    typeof usage[key] === "number" ? [usage[key] as number] : [],
  );
  return values.length > 0
    ? { [key]: values.reduce((total, value) => total + value, 0) } as Partial<Record<K, number>>
    : {};
}
