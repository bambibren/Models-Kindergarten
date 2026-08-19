import type {
  ContentBlock,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
} from "@agentclientprotocol/sdk";
import type {
  ContextSummary,
  ContextWindowUsageState,
  TokenUsageComponent,
  TurnTokenUsage,
  ArtifactMention,
} from "@kindergarten/contracts";

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
  tokenEstimate?: TokenUsageComponent;
  artifactMentions?: ArtifactMention[];
}

export interface ThoughtEntry extends EntryBase {
  type: "thought";
  messageId: string;
  content: ContentBlock[];
  status: "streaming" | "done";
  tokenEstimate?: TokenUsageComponent;
}

export interface ContextSummaryEntry extends EntryBase {
  type: "context_summary";
  summary: ContextSummary;
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
  tokenEstimate?: TokenUsageComponent;
}

export interface TokenUsageEntry extends EntryBase {
  type: "token_usage";
  usage: TurnTokenUsage;
}

export interface ContextWindowUsageEntry extends EntryBase {
  type: "context_window_usage";
  state: ContextWindowUsageState;
}

export type ChatEntry =
  | MessageEntry
  | ContextSummaryEntry
  | ThoughtEntry
  | ToolCallEntry
  | TokenUsageEntry
  | ContextWindowUsageEntry;

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
 * historyChatEntries 是已提交历史投影；streamingChatEntries 是当前 ACP 操作的临时投影。
 * order 固定首次出现次序，byId 允许并行 Tool 按 ID 独立更新。
 */
export interface ChatState {
  sessionId: string | null;
  historyChatEntries: EntryCollection;
  streamingChatEntries: EntryCollection;
  streaming: StreamingContext | null;
}

export const emptyEntries = (): EntryCollection => ({ order: [], byId: {} });
