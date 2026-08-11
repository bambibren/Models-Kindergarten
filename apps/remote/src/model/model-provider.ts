export type ModelProviderKind = "ollama" | "siliconflow" | "openai-compatible";

export interface ModelStudent {
  id: string;
  name: string;
  provider: {
    kind: ModelProviderKind;
    model: string;
    baseUrl: string;
  };
  agentConfig: {
    systemPrompt: string;
    temperature?: number;
  };
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  thinking?: string;
  toolCalls?: ModelToolCall[];
  toolName?: string;
  toolCallId?: string;
}

export interface ModelInput {
  messages: ModelMessage[];
  tools: ModelToolDefinition[];
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

export interface ModelToolCall {
  id?: string;
  index?: number;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ModelToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    /** MCP Tool 可以声明完整 JSON Schema，Provider Adapter 不应截断方言。 */
    parameters: ModelToolSchema;
  };
}

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

export type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | ({ type: "usage" } & ModelUsage)
  | { type: "tool_calls"; calls: ModelToolCall[] }
  | { type: "finish"; reason: "stop" | "length" | "cancelled" };

/** Provider Adapter 不认识 ACP、WebSocket、React 或 Session Repository。 */
export interface ModelProvider {
  readonly student: ModelStudent;
  verify?(): Promise<void>;
  serializeContext(fragment: ModelContextFragment): ModelContextSerialization;
  stream(input: ModelInput, signal: AbortSignal): AsyncIterable<ModelEvent>;
}
