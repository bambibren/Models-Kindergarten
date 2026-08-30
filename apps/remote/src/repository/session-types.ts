import type {
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
} from "@agentclientprotocol/sdk";
import type {
  BuiltinToolBinding,
  BuiltinSkillBinding,
  ContextSummary,
  HistoryPolicy,
  McpBinding,
  SkillBinding,
  TurnTokenUsage,
  ConcreteReasoningProfile,
  ArtifactMention,
  ContextWindowUsageState,
  ResolvedReasoningSnapshot,
  TurnState,
} from "@kindergarten/contracts";
import type { RuntimeCapabilitySnapshot } from "../capability/capability-types.js";
import type { ModelContextSerialization } from "../model/model-provider.js";
import type { ProviderOpaqueContinuation } from "../model/provider-continuation.js";

/** 描述「SessionRole」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type SessionRole = "user" | "assistant";
/** 描述「SessionPurpose」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type SessionPurpose = "chat" | "experiment";

/** 描述「SessionExperimentRef」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface SessionExperimentRef {
  experimentId: string;
  variantId: string;
}

/** 描述「TurnExecutionRecord」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface TurnExecutionRecord {
  schemaVersion: 1;
  turnId: string;
  state: TurnState;
  startedAt: string;
  completedAt?: string;
  promptEntryId?: string;
  entryIds?: string[];
  modelStudentId?: string;
  providerKind?: string;
  model?: string;
  agentId?: string;
  agentSnapshotHash?: string;
  agentSnapshot?: {
    systemPrompt: string;
    builtinTools: BuiltinToolBinding[];
    builtinSkills: BuiltinSkillBinding[];
    skills: SkillBinding[];
    mcps: McpBinding[];
    historyPolicy: HistoryPolicy;
    memoryPolicy: { mode: "off" };
  };
  capabilitySnapshots?: Array<{
    generation: number;
    hash: string;
    snapshot: RuntimeCapabilitySnapshot;
  }>;
  modelRounds?: Array<{
    roundIndex: number;
    capabilityGeneration: number;
    contextSummary: ContextSummary;
    /** 只在写入 Repository 前短暂存在；V5 落盘后必须被 evidence 引用替换。 */
    providerInput?: ModelContextSerialization;
    providerInputRef?: string;
    providerInputHash?: string;
    providerInputBytes?: number;
    providerInputProvider?: ModelContextSerialization["provider"];
    providerInputModel?: string;
    providerInputFormat?: ModelContextSerialization["format"];
    startedAt: string;
    completedAt?: string;
    resolvedReasoning?: ResolvedReasoningSnapshot;
  }>;
  usage?: TurnTokenUsage;
  stopReason?: string;
  error?: { code: string; message: string; retryable: boolean };
  fileReferenceIds?: string[];
  resolvedReasoning?: ResolvedReasoningSnapshot;
}

/** 描述「SessionMessageEntry」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface SessionMessageEntry {
  type: "message";
  role: SessionRole;
  text: string;
  turnId: string;
  messageId: string;
  createdAt: string;
  artifactMentions?: ArtifactMention[];
}

/** 描述「SessionThoughtEntry」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface SessionThoughtEntry {
  type: "thought";
  text: string;
  turnId: string;
  messageId: string;
  createdAt: string;
}

/** 描述「SessionContextSummaryEntry」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface SessionContextSummaryEntry {
  type: "context_summary";
  turnId: string;
  summary: ContextSummary;
  createdAt: string;
}

/** 描述「SessionTokenUsageEntry」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface SessionTokenUsageEntry {
  type: "token_usage";
  turnId: string;
  usage: TurnTokenUsage;
  createdAt: string;
}

/** 描述「SessionContextWindowUsageEntry」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface SessionContextWindowUsageEntry {
  type: "context_window_usage";
  turnId: string;
  state: ContextWindowUsageState;
  createdAt: string;
}

/** 描述「SessionToolOutcomeStatus」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type SessionToolOutcomeStatus =
  | "success"
  | "error"
  | "denied"
  | "duplicate_blocked";

/** 描述「SessionToolCallEntry」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
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

/**
 * 不投影到聊天 UI 的 Provider 原始响应事实。关联 ID 位于通用 continuation
 * 信封中；Session / Context 不解释 Provider 私有 payload。
 */
export interface SessionProviderContinuationEntry {
  type: "provider_continuation";
  turnId: string;
  roundIndex: number;
  continuation: ProviderOpaqueContinuation;
  createdAt: string;
}

/** 观测事实只回放到聊天，不再次进入模型上下文。 */
export type SessionEntry =
  | SessionMessageEntry
  | SessionContextSummaryEntry
  | SessionTokenUsageEntry
  | SessionContextWindowUsageEntry
  | SessionThoughtEntry
  | SessionToolCallEntry
  | SessionProviderContinuationEntry;

/** 描述「SessionRecord」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface SessionRecord {
  schemaVersion: 5;
  id: string;
  revision: number;
  ownerId: string;
  purpose: SessionPurpose;
  cwd: string;
  additionalDirectories: string[];
  title: string;
  modelStudentId: string;
  agentId: string;
  reasoningOverride?: ConcreteReasoningProfile;
  experimentReasoning?: ResolvedReasoningSnapshot;
  experimentRef?: SessionExperimentRef;
  createdAt: string;
  updatedAt: string;
  sessionEntries: SessionEntry[];
  turns: TurnExecutionRecord[];
}
