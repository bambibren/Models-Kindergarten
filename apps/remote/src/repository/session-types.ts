import type {
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
} from "@agentclientprotocol/sdk";

export type StoredRole = "user" | "assistant";

export interface StoredMessage {
  type: "message";
  role: StoredRole;
  text: string;
  turnId: string;
  messageId: string;
  createdAt: string;
}

export interface StoredThought {
  type: "thought";
  text: string;
  turnId: string;
  messageId: string;
  createdAt: string;
}

export interface StoredToolCall {
  type: "tool_call";
  turnId: string;
  toolCallId: string;
  title: string;
  name: string;
  kind: ToolKind;
  status: ToolCallStatus;
  rawInput: unknown;
  rawOutput?: unknown;
  content: ToolCallContent[];
  locations: ToolCallLocation[];
  createdAt: string;
}

/** 稳定会话历史使用与 Web ChatEntry 相同的顺序语义，但不保存流式草稿。 */
export type StoredEntry = StoredMessage | StoredThought | StoredToolCall;

export interface StoredSession {
  id: string;
  cwd: string;
  title: string;
  updatedAt: string;
  entries: StoredEntry[];
}
