import type {
  ConcreteReasoningProfile,
  ModelReasoningCapability,
  ResolvedReasoningSnapshot,
} from "@kindergarten/contracts";
import type { ProviderOpaqueContinuation } from "./provider-continuation.js";

/** 描述「ModelProviderKind」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ModelProviderKind = "ollama" | "siliconflow" | "openai-compatible";

/** 描述「ModelStudent」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ModelStudent {
  id: string;
  name: string;
  /** 显式模型配置；Runtime 不通过模型名称或参数量字符串猜测能力。 */
  sizeClass: "small" | "large";
  /** 用户显式配置的上下文窗口；未知时缺省。 */
  contextWindowTokens?: number;
  provider: {
    kind: ModelProviderKind;
    model: string;
    baseUrl: string;
  };
  generationDefaults: {
    temperature?: number;
    reasoningProfile?: ConcreteReasoningProfile;
  };
}

/** 描述「ModelMessage」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  thinking?: string;
  toolCalls?: ModelToolCall[];
  toolName?: string;
  toolCallId?: string;
  /** 只允许生成它的 Provider Adapter 消费；通用 Runtime 不解释 opaque payload。 */
  providerOpaqueContinuation?: ProviderOpaqueContinuation;
}

/** 模型下一轮上下文中用于关联一次工具调用的终态结果消息。 */
export interface ToolResultMessage extends ModelMessage {
  role: "tool";
  content: string;
  toolName: string;
  toolCallId: string;
}

/** 描述「ModelInput」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ModelInput {
  systemPrompt: string;
  messages: ModelMessage[];
  tools: ModelToolDefinition[];
  /** Runtime 在 Turn 边界解析并冻结；Provider 只读 native 字段。disabled 仅保留给内部结构化任务。 */
  reasoning?: ResolvedReasoningSnapshot | "disabled";
}

/** Runtime 负责选择上下文模块，Provider Adapter 只负责生成自己的真实请求格式。 */
export type ModelContextFragment =
  | { kind: "system"; content: string }
  | { kind: "tools"; tools: ModelToolDefinition[] }
  | { kind: "messages"; messages: ModelMessage[] }
  | { kind: "omitted"; sourceIds: string[] };

/** 可持久化的适配层原文快照；value 必须来自实际请求使用的同一组转换函数。 */
export interface ModelContextSerialization {
  provider: ModelProviderKind;
  model: string;
  format: "json" | "text";
  value: string;
}

/** 描述「ModelToolCall」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ModelToolCall {
  id?: string;
  index?: number;
  name: string;
  arguments: Record<string, unknown>;
}

/** 描述「ModelToolDefinition」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ModelToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    /** MCP Tool 可以声明完整 JSON Schema，Provider Adapter 不应截断方言。 */
    parameters: ModelToolSchema;
  };
}

/** 描述「ModelToolSchema」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ModelToolSchema extends Record<string, unknown> {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

/**
 * input/output 是 Provider 报告的互斥顶层总量；cached/reasoning 是各自总量的子集。
 * Provider 没有报告的字段必须保持 undefined，不能用 0 冒充。
 */
export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
}

/**
 * Provider wire 层消息数上限。`maxMessages` 统计最终出站数组，
 * `adapterReservedMessages` 预留 Adapter 在 `ModelInput.messages` 之外添加的消息，
 * 例如首条 system instruction。
 */
export interface ModelInputMessageLimits {
  maxMessages: number;
  adapterReservedMessages: number;
  /** 初始历史预算预留一条 assistant 和一条 tool result，保证首轮工具回填仍可继续。 */
  initialToolRoundHeadroom: number;
}

/** 描述「ModelEvent」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | ({ type: "usage" } & ModelUsage)
  | { type: "tool_calls"; calls: ModelToolCall[] }
  | { type: "provider_continuation"; continuation: ProviderOpaqueContinuation }
  | { type: "finish"; reason: "stop" | "length" | "cancelled" };

/** Provider Adapter 不认识 ACP、WebSocket、React 或 Session Repository。 */
export interface ModelProvider {
  readonly student: ModelStudent;
  /** 可选：V1 的多数协议并未公布较小的硬消息数上限。 */
  readonly inputMessageLimits?: ModelInputMessageLimits;
  /** 真实 Provider 必须声明；测试 Fixture 可省略并由 Runtime 按 fixed balanced 处理。 */
  readonly reasoningCapability?: ModelReasoningCapability;
  /** 产品档位到 Provider 原生参数的唯一转换边界。 */
  nativeReasoning?(profile: ConcreteReasoningProfile): Record<string, string | number | boolean>;
  verify?(): Promise<void>;
  serializeContext(fragment: ModelContextFragment): ModelContextSerialization;
  /** 与 stream 使用同一转换函数生成、但不包含 Secret/Header 的完整请求快照。 */
  serializeInput?(input: ModelInput): ModelContextSerialization;
  /** Adapter 每收到一个原始模型流事件就调用 onActivity，不以聚合后的 ModelEvent 代替。 */
  stream(
    input: ModelInput,
    signal: AbortSignal,
    onActivity?: () => void,
  ): AsyncIterable<ModelEvent>;
}

/** 扣除 Adapter 自有消息与预留空间后，计算 `ModelInput.messages` 的最大数量。 */
export function modelInputMessageCapacity(
  provider: ModelProvider,
  reserveInitialToolRound = false,
): number | undefined {
  const limits = provider.inputMessageLimits;
  if (!limits) return undefined;
  const values = [
    limits.maxMessages,
    limits.adapterReservedMessages,
    limits.initialToolRoundHeadroom,
  ];
  if (
    values.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(value) => !Number.isInteger(value) || value < 0)
    || limits.maxMessages < 1
  ) {
    throw new Error(`ModelProvider ${provider.student.id} 的输入消息限制无效`);
  }
  const available = limits.maxMessages
    - limits.adapterReservedMessages
    - (reserveInitialToolRound ? limits.initialToolRoundHeadroom : 0);
  if (available < 1) {
    throw new Error(`ModelProvider ${provider.student.id} 没有为当前用户消息保留输入容量`);
  }
  return available;
}
