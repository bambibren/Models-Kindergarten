import type { EntryCollection } from "../../chat/chat-types.js";
import { selectSessionTokenUsage } from "../../chat/token-usage.js";
import { formatTokenCount } from "../tokens/token-format.js";

export function TokenUsageTotal({ history, streaming }: {
  history: EntryCollection;
  streaming: EntryCollection;
}) {
  const usage = selectSessionTokenUsage(history, streaming);
  if (!usage || (usage.inputTokens === undefined && usage.outputTokens === undefined)) return null;

  const details = [
    `Provider 精确计数 · ${usage.modelRequests} 次模型请求`,
    usage.cachedInputTokens !== undefined
      ? `缓存输入 ${formatTokenCount(usage.cachedInputTokens)} tokens（已包含在输入）`
      : "",
    usage.reasoningOutputTokens !== undefined
      ? `推理输出 ${formatTokenCount(usage.reasoningOutputTokens)} tokens（已包含在输出）`
      : "",
  ].filter(Boolean).join("；");

  return <footer className="token-usage-total" title={details}>
    <span>本会话</span>
    {usage.inputTokens !== undefined && <span>输入 {formatTokenCount(usage.inputTokens)} tokens</span>}
    {usage.outputTokens !== undefined && <span>输出 {formatTokenCount(usage.outputTokens)} tokens</span>}
  </footer>;
}
