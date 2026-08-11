export const META_KEY = "modelKindergarten" as const;
export const CONTEXT_SUMMARY_NOTIFICATION =
  "model-kindergarten/session/context-summary" as const;
export const TOKEN_USAGE_NOTIFICATION =
  "model-kindergarten/session/token-usage" as const;

export type ContextSummaryKind =
  | "system_instruction"
  | "available_tools"
  | "skill_catalog"
  | "mcp_resource_catalog"
  | "mcp_resource"
  | "session_history"
  | "truncated_history";

/** 当前 ModelStudent 的 Provider Adapter 已经序列化完成的只读原文快照。 */
export interface ContextSummaryRaw {
  provider: string;
  model: string;
  format: "json" | "text";
  value: string;
}

export interface ContextSummaryItem {
  id: string;
  kind: ContextSummaryKind;
  title: string;
  detail?: string;
  itemCount?: number;
  estimatedTokens: number;
  trust?: "trusted" | "approved" | "untrusted";
  /** 旧 Session 可能没有该字段；新生成的提要必须由 Remote 写入。 */
  raw?: ContextSummaryRaw;
}

/**
 * 本轮实际交给模型、但不在当前用户气泡中重复展示的上下文提要。
 * 当前 prompt（以及未来同属 prompt 的 Mention/附件）由 Remote 在生成时排除。
 */
export interface ContextSummary {
  schemaVersion: 1;
  turnId: string;
  items: ContextSummaryItem[];
  totalEstimatedTokens: number;
}

export interface ContextSummaryNotification {
  sessionId: string;
  summary: ContextSummary;
}

export type TokenUsageCategory =
  | "current_prompt"
  | "reasoning"
  | "tool_call"
  | "answer";

export type TokenUsageTargetType = "message" | "thought" | "tool_call";

/** 内容附近的分项只能估算；精确总量来自 Provider usage。 */
export interface TokenUsageComponent {
  category: TokenUsageCategory;
  targetType: TokenUsageTargetType;
  targetId: string;
  estimatedTokens: number;
}

/** cachedInputTokens 属于 inputTokens，reasoningOutputTokens 属于 outputTokens。 */
export interface TurnTokenUsage {
  schemaVersion: 1;
  turnId: string;
  modelRequests: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
  components: TokenUsageComponent[];
}

export interface TokenUsageNotification {
  sessionId: string;
  usage: TurnTokenUsage;
}

/**
 * ACP v1 已原生提供 messageId，这个扩展只补足轮次和 Chunk 边界。
 * Runtime 状态、UI 状态和持久化结构都不能塞进 `_meta`。
 */
export interface MessageMeta {
  schemaVersion: 1;
  turnId: string;
  chunkIndex: number;
  final?: boolean;
}

export interface PromptMeta {
  schemaVersion: 1;
  turnId: string;
}

export interface KindergartenMeta {
  message?: MessageMeta;
  prompt?: PromptMeta;
}

export interface AcpMeta extends Record<string, unknown> {
  [META_KEY]: KindergartenMeta;
}

export function makeAcpMeta(message: MessageMeta): AcpMeta {
  return {
    [META_KEY]: { message },
  };
}

export function makePromptMeta(prompt: PromptMeta): AcpMeta {
  return {
    [META_KEY]: { prompt },
  };
}

export function readMessageMeta(value: unknown): MessageMeta | undefined {
  if (!isRecord(value)) return undefined;
  const root = value[META_KEY];
  if (!isRecord(root) || !isRecord(root.message)) return undefined;

  const meta = root.message;
  if (
    meta.schemaVersion !== 1 ||
    typeof meta.turnId !== "string" ||
    typeof meta.chunkIndex !== "number"
  ) {
    return undefined;
  }

  return {
    schemaVersion: 1,
    turnId: meta.turnId,
    chunkIndex: meta.chunkIndex,
    ...(typeof meta.final === "boolean" ? { final: meta.final } : {}),
  };
}

export function readPromptMeta(value: unknown): PromptMeta | undefined {
  if (!isRecord(value)) return undefined;
  const root = value[META_KEY];
  if (!isRecord(root) || !isRecord(root.prompt)) return undefined;

  const meta = root.prompt;
  if (
    meta.schemaVersion !== 1 ||
    typeof meta.turnId !== "string"
  ) {
    return undefined;
  }

  return {
    schemaVersion: 1,
    turnId: meta.turnId,
  };
}

/** ACP 自定义通知的边界校验器；可直接交给 SDK 的自定义 method parser。 */
export function readContextSummaryNotification(
  value: unknown,
): ContextSummaryNotification {
  if (!isRecord(value) || typeof value.sessionId !== "string") {
    throw new Error("上下文提要通知缺少 sessionId");
  }
  const summary = value.summary;
  if (
    !isRecord(summary) ||
    summary.schemaVersion !== 1 ||
    typeof summary.turnId !== "string" ||
    !Array.isArray(summary.items) ||
    typeof summary.totalEstimatedTokens !== "number"
  ) {
    throw new Error("上下文提要通知格式无效");
  }
  const items = summary.items.map(readContextSummaryItem);
  return {
    sessionId: value.sessionId,
    summary: {
      schemaVersion: 1,
      turnId: summary.turnId,
      items,
      totalEstimatedTokens: summary.totalEstimatedTokens,
    },
  };
}

/** Provider 精确总量与 UI 估算分项的 ACP 自定义通知边界校验器。 */
export function readTokenUsageNotification(
  value: unknown,
): TokenUsageNotification {
  if (!isRecord(value) || typeof value.sessionId !== "string") {
    throw new Error("Token 用量通知缺少 sessionId");
  }
  const usage = value.usage;
  if (
    !isRecord(usage) ||
    usage.schemaVersion !== 1 ||
    typeof usage.turnId !== "string" ||
    !isTokenCount(usage.modelRequests) ||
    usage.modelRequests < 1 ||
    !Array.isArray(usage.components)
  ) {
    throw new Error("Token 用量通知格式无效");
  }
  return {
    sessionId: value.sessionId,
    usage: {
      schemaVersion: 1,
      turnId: usage.turnId,
      modelRequests: usage.modelRequests,
      components: usage.components.map(readTokenUsageComponent),
      ...optionalTokenCount(usage, "inputTokens"),
      ...optionalTokenCount(usage, "outputTokens"),
      ...optionalTokenCount(usage, "cachedInputTokens"),
      ...optionalTokenCount(usage, "reasoningOutputTokens"),
    },
  };
}

function readTokenUsageComponent(value: unknown): TokenUsageComponent {
  if (
    !isRecord(value) ||
    !isTokenUsageCategory(value.category) ||
    !isTokenUsageTargetType(value.targetType) ||
    typeof value.targetId !== "string" ||
    !isTokenCount(value.estimatedTokens) ||
    !validTarget(value.category, value.targetType)
  ) {
    throw new Error("Token 用量分项格式无效");
  }
  return {
    category: value.category,
    targetType: value.targetType,
    targetId: value.targetId,
    estimatedTokens: value.estimatedTokens,
  };
}

function optionalTokenCount<K extends string>(
  value: Record<string, unknown>,
  key: K,
): Record<K, number> | Record<string, never> {
  const count = value[key];
  if (count === undefined) return {};
  if (!isTokenCount(count)) throw new Error(`Token 用量字段无效: ${key}`);
  return { [key]: count } as Record<K, number>;
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isTokenUsageCategory(value: unknown): value is TokenUsageCategory {
  return value === "current_prompt" ||
    value === "reasoning" ||
    value === "tool_call" ||
    value === "answer";
}

function isTokenUsageTargetType(value: unknown): value is TokenUsageTargetType {
  return value === "message" || value === "thought" || value === "tool_call";
}

function validTarget(
  category: TokenUsageCategory,
  targetType: TokenUsageTargetType,
): boolean {
  if (category === "current_prompt" || category === "answer") return targetType === "message";
  if (category === "reasoning") return targetType === "thought";
  return targetType === "tool_call";
}

function readContextSummaryItem(value: unknown): ContextSummaryItem {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !isContextSummaryKind(value.kind) ||
    typeof value.title !== "string" ||
    typeof value.estimatedTokens !== "number"
  ) {
    throw new Error("上下文提要条目格式无效");
  }
  return {
    id: value.id,
    kind: value.kind,
    title: value.title,
    estimatedTokens: value.estimatedTokens,
    ...(typeof value.detail === "string" ? { detail: value.detail } : {}),
    ...(typeof value.itemCount === "number" ? { itemCount: value.itemCount } : {}),
    ...(isContextTrust(value.trust) ? { trust: value.trust } : {}),
    ...(value.raw !== undefined ? { raw: readContextSummaryRaw(value.raw) } : {}),
  };
}

function readContextSummaryRaw(value: unknown): ContextSummaryRaw {
  if (
    !isRecord(value) ||
    typeof value.provider !== "string" || value.provider.length === 0 ||
    typeof value.model !== "string" || value.model.length === 0 ||
    (value.format !== "json" && value.format !== "text") ||
    typeof value.value !== "string" || value.value.length === 0
  ) {
    throw new Error("上下文提要原文格式无效");
  }
  return {
    provider: value.provider,
    model: value.model,
    format: value.format,
    value: value.value,
  };
}

function isContextSummaryKind(value: unknown): value is ContextSummaryKind {
  return value === "system_instruction" ||
    value === "available_tools" ||
    value === "skill_catalog" ||
    value === "mcp_resource_catalog" ||
    value === "mcp_resource" ||
    value === "session_history" ||
    value === "truncated_history";
}

function isContextTrust(value: unknown): value is NonNullable<ContextSummaryItem["trust"]> {
  return value === "trusted" || value === "approved" || value === "untrusted";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
