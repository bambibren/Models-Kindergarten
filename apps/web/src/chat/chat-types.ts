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

/** 描述「EntryId」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type EntryId = string;
/** 描述「ChatRole」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ChatRole = "user" | "assistant";
/** 描述「StreamSource」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type StreamSource = "prompt" | "load";

interface EntryBase {
  id: EntryId;
  turnId: string;
}

/** 描述「MessageEntry」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface MessageEntry extends EntryBase {
  type: "message";
  messageId: string | null;
  role: ChatRole;
  content: ContentBlock[];
  status: "streaming" | "done";
  tokenEstimate?: TokenUsageComponent;
  artifactMentions?: ArtifactMention[];
}

/** 描述「ThoughtEntry」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ThoughtEntry extends EntryBase {
  type: "thought";
  messageId: string;
  content: ContentBlock[];
  status: "streaming" | "done";
  tokenEstimate?: TokenUsageComponent;
}

/** 描述「ContextSummaryEntry」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ContextSummaryEntry extends EntryBase {
  type: "context_summary";
  summary: ContextSummary;
}

/** 描述「ToolCallEntry」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
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

/** 描述「TokenUsageEntry」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface TokenUsageEntry extends EntryBase {
  type: "token_usage";
  usage: TurnTokenUsage;
}

/** 描述「ContextWindowUsageEntry」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ContextWindowUsageEntry extends EntryBase {
  type: "context_window_usage";
  state: ContextWindowUsageState;
}

/** 描述「ChatEntry」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ChatEntry =
  | MessageEntry
  | ContextSummaryEntry
  | ThoughtEntry
  | ToolCallEntry
  | TokenUsageEntry
  | ContextWindowUsageEntry;

/** 描述「EntryCollection」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface EntryCollection {
  order: EntryId[];
  byId: Record<EntryId, ChatEntry>;
}

/** 描述「StreamingContext」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
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

export const emptyEntries = /** 执行「emptyEntries」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(): EntryCollection => ({ order: [], byId: {} });
