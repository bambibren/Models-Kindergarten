import type {
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
} from "@agentclientprotocol/sdk";
import type { ContextSummary, TurnTokenUsage } from "@kindergarten/contracts";

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

export interface SessionContextSummaryEntry {
  type: "context_summary";
  turnId: string;
  summary: ContextSummary;
  createdAt: string;
}

export interface SessionTokenUsageEntry {
  type: "token_usage";
  turnId: string;
  usage: TurnTokenUsage;
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

/** context_summary/token_usage 只回放到聊天，不再次进入模型上下文。 */
export type SessionEntry =
  | SessionMessageEntry
  | SessionContextSummaryEntry
  | SessionTokenUsageEntry
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
