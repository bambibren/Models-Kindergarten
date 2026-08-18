import type {
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
} from "@agentclientprotocol/sdk";
import type {
  BuiltinToolBinding,
  ContextSummary,
  HistoryPolicy,
  McpBinding,
  SkillBinding,
  TurnTokenUsage,
  ConcreteReasoningProfile,
  ArtifactMention,
  ResolvedReasoningSnapshot,
  TurnState,
} from "@kindergarten/contracts";
import type { RuntimeCapabilitySnapshot } from "../capability/capability-types.js";
import type { ModelContextSerialization } from "../model/model-provider.js";
import type { ProviderOpaqueContinuation } from "../model/provider-continuation.js";

export type SessionRole = "user" | "assistant";
export type SessionPurpose = "chat" | "experiment";

export interface SessionExperimentRef {
  experimentId: string;
  variantId: string;
}

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
    providerInput: ModelContextSerialization;
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

export interface SessionMessageEntry {
  type: "message";
  role: SessionRole;
  text: string;
  turnId: string;
  messageId: string;
  createdAt: string;
  artifactMentions?: ArtifactMention[];
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

/** context_summary/token_usage 只回放到聊天，不再次进入模型上下文。 */
export type SessionEntry =
  | SessionMessageEntry
  | SessionContextSummaryEntry
  | SessionTokenUsageEntry
  | SessionThoughtEntry
  | SessionToolCallEntry
  | SessionProviderContinuationEntry;

export interface SessionRecord {
  schemaVersion: 4;
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
  experimentRef?: SessionExperimentRef;
  createdAt: string;
  updatedAt: string;
  sessionEntries: SessionEntry[];
  turns: TurnExecutionRecord[];
}
