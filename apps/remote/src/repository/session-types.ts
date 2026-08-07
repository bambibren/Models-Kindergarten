import type {
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
} from "@agentclientprotocol/sdk";

export type SessionRole = "user" | "assistant";

export interface SessionMessageEntry {
  type: "message";
  role: SessionRole;
  text: string;
  turnId: string;
  messageId: string;
  createdAt: string;
}

export interface SessionThoughtEntry {
  type: "thought";
  text: string;
  turnId: string;
  messageId: string;
  createdAt: string;
}

export type SessionToolOutcomeStatus =
  | "success"
  | "error"
  | "denied"
  | "duplicate_blocked";

export interface SessionToolCallEntry {
  type: "tool_call";
  turnId: string;
  toolCallId: string;
  title: string;
  name: string;
  kind: ToolKind;
  status: ToolCallStatus;
  rawInput: unknown;
  rawOutput?: unknown;
  modelContent?: string;
  outcomeStatus?: SessionToolOutcomeStatus;
  content: ToolCallContent[];
  locations: ToolCallLocation[];
  createdAt: string;
}

/** SessionEntry 是聊天历史和模型上下文共同使用的唯一事实源。 */
export type SessionEntry =
  | SessionMessageEntry
  | SessionThoughtEntry
  | SessionToolCallEntry;

export interface SessionRecord {
  id: string;
  revision: number;
  cwd: string;
  title: string;
  updatedAt: string;
  sessionEntries: SessionEntry[];
}
