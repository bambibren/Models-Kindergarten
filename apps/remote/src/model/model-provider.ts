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
    parameters: {
      type: "object";
      properties: Record<string, ModelToolParameter>;
      required?: string[];
      additionalProperties?: boolean;
    };
  };
}

export interface ModelToolParameter {
  type: "string" | "number" | "integer" | "boolean" | "array";
  description?: string;
  items?: { type: "string" };
  minLength?: number;
  maxLength?: number;
}

export type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | {
      type: "usage";
      inputTokens?: number;
      outputTokens?: number;
    }
  | { type: "tool_calls"; calls: ModelToolCall[] }
  | { type: "finish"; reason: "stop" | "length" | "cancelled" };

/** Provider Adapter 不认识 ACP、WebSocket、React 或 Session Repository。 */
export interface ModelProvider {
  readonly student: ModelStudent;
  verify?(): Promise<void>;
  stream(input: ModelInput, signal: AbortSignal): AsyncIterable<ModelEvent>;
}
