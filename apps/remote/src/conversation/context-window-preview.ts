import {
  modelInputMessageCapacity,
  type ModelProvider,
  type ModelToolDefinition,
} from "../model/model-provider.js";
import type { SessionEntry } from "../repository/session-types.js";
import {
  ContextAssembler,
  rebudgetContextMessages,
} from "./context-assembler.js";

export interface ContextWindowPreview {
  estimatedTokens: number;
  windowTokens: number;
  basis: "next_prompt_base";
}

/**
 * 按下一次真实请求的上下文结构做只读预演；空 prompt 只保留消息信封，
 * 不代表用户已经提交新内容，也绝不调用 ModelProvider.stream()。
 */
export async function previewContextWindow(input: {
  model: ModelProvider;
  context: ContextAssembler;
  systemPrompt: string;
  tools: ModelToolDefinition[];
  sessionEntries: SessionEntry[];
  signal: AbortSignal;
}): Promise<ContextWindowPreview | undefined> {
  const windowTokens = input.model.student.contextWindowTokens;
  if (windowTokens === undefined) return undefined;

  const built = await input.context.buildObserved(input.sessionEntries, "", input.signal);
  const capacity = modelInputMessageCapacity(input.model, input.tools.length > 0);
  const messages = capacity === undefined
    ? built.messages
    : rebudgetContextMessages(built.messages, built.observations, capacity).messages;
  const serialized = [
    input.model.serializeContext({ kind: "system", content: input.systemPrompt }).value,
    input.model.serializeContext({ kind: "tools", tools: input.tools }).value,
    input.model.serializeContext({ kind: "messages", messages }).value,
  ].join("");

  return {
    estimatedTokens: Math.max(1, Math.ceil(serialized.length / 4)),
    windowTokens,
    basis: "next_prompt_base",
  };
}
