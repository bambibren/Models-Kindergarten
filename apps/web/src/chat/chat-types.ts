import type {
  ContentBlock,
  StopReason,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
} from "@agentclientprotocol/sdk";

export type EntryId = string;
export type ChatRole = "user" | "assistant";
export type StreamSource = "prompt" | "load";

interface EntryBase {
  id: EntryId;
  turnId: string;
}

export interface MessageEntry extends EntryBase {
  type: "message";
  messageId: string | null;
  role: ChatRole;
  content: ContentBlock[];
  status: "streaming" | "done";
}

export interface ThoughtEntry extends EntryBase {
  type: "thought";
  messageId: string;
  content: ContentBlock[];
  status: "streaming" | "done";
}

export interface ToolCallEntry extends EntryBase {
  type: "tool_call";
  toolCallId: string;
  title: string;
  name?: string;
  kind: ToolKind;
  status: ToolCallStatus;
  content: ToolCallContent[];
  locations: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

export type ChatEntry = MessageEntry | ThoughtEntry | ToolCallEntry;

export interface EntryCollection {
  order: EntryId[];
  byId: Record<EntryId, ChatEntry>;
}

export interface StreamingContext {
  operationId: string;
  source: StreamSource;
  turnId: string;
  seenChunks: ReadonlySet<string>;
  optimisticUserEntryId?: EntryId;
}

/**
 * entries 是已提交历史；streamingEntries 是当前 ACP 操作的唯一临时投影。
 * order 固定首次出现次序，byId 允许并行 Tool 按 ID 独立更新。
 */
export interface ChatState {
  sessionId: string | null;
  entries: EntryCollection;
  streamingEntries: EntryCollection;
  streaming: StreamingContext | null;
  lastStopReason?: StopReason;
}

export const emptyEntries = (): EntryCollection => ({ order: [], byId: {} });
