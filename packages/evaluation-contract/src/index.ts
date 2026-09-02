import type {
  ModelInputMessageTrace,
  RuntimePayloadEvidence,
  RuntimeResolvedReasoningSnapshot,
  RuntimeVariantSnapshot,
} from "@kindergarten/runtime-observation";

/** 一次逻辑 Model Round 内的单次 Provider 请求；失败 Attempt 只留在 Trace。 */
export interface ModelAttemptTrace {
  id: string;
  index: number;
  startedAt: number;
  completedAt?: number;
  status: "running" | "completed" | "failed";
  error?: { code: string; message: string; retryable: boolean };
  output?: {
    text: RuntimePayloadEvidence;
    thinking?: RuntimePayloadEvidence;
  };
  retryDelayMs?: number;
}

/** 描述「ModelRoundTrace」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ModelRoundTrace {
  id: string;
  index: number;
  startedAt: number;
  resolvedReasoning: RuntimeResolvedReasoningSnapshot;
  firstTokenAt?: number;
  completedAt?: number;
  stopReason?: "stop" | "length" | "cancelled";
  output?: {
    text: RuntimePayloadEvidence;
    thinking?: RuntimePayloadEvidence;
  };
  context: {
    messages: ModelInputMessageTrace[];
    truncatedSourceIds: string[];
    inputTokens?: number;
  };
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
  /** 旧 Trace 可没有该字段；新 Trace 会记录首次请求和全部自动重试。 */
  attempts?: ModelAttemptTrace[];
}

/** 描述「ToolCallTrace」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ToolCallTrace {
  toolCallId: string;
  modelRoundId: string;
  name: string;
  arguments: RuntimePayloadEvidence;
  signatureHash: string;
  permission: "allow" | "ask" | "always_ask" | "deny";
  status?: "success" | "error" | "denied" | "duplicate_blocked";
  startedAt: number;
  completedAt?: number;
  error?: { category: string; message: string };
  output?: RuntimePayloadEvidence;
}

/** 描述「PermissionTrace」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface PermissionTrace {
  toolCallId: string;
  required: boolean;
  decision: "allowed" | "denied";
  decidedAt: number;
}

/** 描述「RuntimeErrorTrace」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface RuntimeErrorTrace {
  scope: "model" | "tool_runtime" | "turn";
  message: string;
  at: number;
}

/** 描述「TurnTraceDocument」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface TurnTraceDocument {
  schemaVersion: 2;
  traceId: string;
  runId: string;
  sessionId: string;
  turnId: string;
  variant: RuntimeVariantSnapshot;
  resolvedReasoning: RuntimeResolvedReasoningSnapshot;
  status: "completed" | "failed" | "cancelled";
  stopReason?: string;
  startedAt: number;
  completedAt: number;
  modelRounds: ModelRoundTrace[];
  toolCalls: ToolCallTrace[];
  permissions: PermissionTrace[];
  errors: RuntimeErrorTrace[];
}

/** 描述「MinimalTurnEvaluationResult」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface MinimalTurnEvaluationResult {
  normallyCompleted: boolean;
  modelRoundCount: number;
  toolCallCount: number;
  toolSuccessCount: number;
  toolFailureCount: number;
  hasRepeatedToolCall: boolean;
  totalContextTokens: number;
  truncatedContextItemCount: number;
  firstTokenLatencyMs?: number;
  totalDurationMs: number;
  totalOutputTokens: number;
  errorCount: number;
  permissionViolationCount: number;
}

/** 描述「TurnEvaluationRecord」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface TurnEvaluationRecord {
  schemaVersion: 2;
  trace: TurnTraceDocument;
  result: MinimalTurnEvaluationResult;
  createdAt: string;
}

/** 已完成 Turn 的人工效果标注；执行分仍由 Runtime Evaluation 自动生成。 */
export interface TurnEffectScoreDraft {
  schemaVersion: 1;
  annotations: {
    understanding: {
      requirements: Array<{
        requirementId: string;
        label: string;
        weight: number;
        verdict: "met" | "missed" | "unmarked";
      }>;
      completed: boolean;
    };
    planning: {
      score?: number;
      completed: boolean;
    };
    output: {
      score: number;
      marks: Array<{
        markId?: string;
        answerSectionId: string;
        start: number;
        end: number;
        verdict: "effective" | "partial";
        quotedTextHash: string;
      }>;
      artifactScore?: number;
      completed: boolean;
    };
  };
}

/** 人工效果打分绑定唯一 Session/Turn，并以 scoreResultId 关联独立原子评分。 */
export interface TurnEffectScoreRecord extends TurnEffectScoreDraft {
  sessionId: string;
  turnId: string;
  /** 旧记录可缺失；首次重存或启动迁移后补齐稳定原子评分 ID。 */
  scoreResultId?: string;
  executionScore: number;
  savedAt: string;
}

/** 用于聚合的 Agent 配置快照不依赖可变 Agent 记录，也不包含 Secret。 */
export interface ScoreAgentConfigurationSnapshot {
  configurationHash: string;
  agentSnapshotHash: string;
  agentId: string;
  agentName: string;
  systemPrompt: string;
  builtinTools: Array<{ toolId: string; enabled: boolean; permission: "allow" | "ask" | "deny" }>;
  builtinSkills: Array<{ skillId: string; enabled: boolean }>;
  skills: Array<{ skillInstallationId: string; enabled: boolean }>;
  mcps: Array<{
    mcpInstallationId: string;
    enabled: boolean;
    tools: Array<{ remoteName: string; enabled: boolean; permission: "allow" | "ask" | "deny" }>;
    resources: Array<{ uri: string; enabled: boolean; preload: boolean }>;
  }>;
  historyPolicy: { mode: "none" } | { mode: "recent_turns"; maxTurns: number };
  memoryPolicy: { mode: "off" };
  reasoning: RuntimeResolvedReasoningSnapshot;
}

/** 原子评分通过来源事实决定回到 ABTest 还是单轮评分页。 */
export type ScoreResultSource =
  | { kind: "context_experiment"; experimentId: string; testId: string; scorecardId: string }
  | { kind: "turn_effect"; sessionId: string; turnId: string };

/** ABTest lane 与单轮效果分统一投影成一条可独立索引的评分事实。 */
export interface ScoreResultRecord {
  schemaVersion: 1;
  scoreResultId: string;
  ownerId: string;
  modelStudentId: string;
  source: ScoreResultSource;
  sourceTitle: string;
  agentConfiguration: ScoreAgentConfigurationSnapshot;
  dimensionScores: {
    understanding?: number;
    planning?: number;
    output?: number;
    execution: number;
  };
  status: "draft" | "complete";
  totalScore?: number;
  createdAt: string;
  updatedAt: string;
}

/** 内部写入合同由来源模块提供事实，Evaluation 负责稳定 ID、配置指纹和总分。 */
export interface ScoreResultUpsertInput {
  ownerId: string;
  modelStudentId: string;
  source: ScoreResultSource;
  sourceTitle: string;
  agentConfiguration: Omit<ScoreAgentConfigurationSnapshot, "configurationHash">;
  dimensionScores: ScoreResultRecord["dimensionScores"];
  completed: boolean;
  recordedAt?: string;
}

/** 模型详情只读取已完成评分的 Agent 配置聚合摘要。 */
export interface ModelAgentScoreGroupSummary {
  configurationHash: string;
  agentName: string;
  sampleCount: number;
  averageScore: number;
  minScore: number;
  maxScore: number;
  lastScoredAt: string;
}

/** 配置详情同时返回不可变配置和按时间倒序的原子评分历史。 */
export interface ModelAgentScoreGroupDetail {
  summary: ModelAgentScoreGroupSummary;
  configuration: ScoreAgentConfigurationSnapshot;
  history: ScoreResultRecord[];
}

/** 校验浏览器提交的人工效果打分，拒绝未知字段和无界文本。 */
export function parseTurnEffectScoreDraft(value: unknown): TurnEffectScoreDraft {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.annotations)) {
    throw new Error("效果打分格式无效");
  }
  assertOnlyKeys(value, ["schemaVersion", "annotations"], "效果打分");
  assertOnlyKeys(value.annotations, ["understanding", "planning", "output"], "效果标注");
  const understanding = value.annotations.understanding;
  const planning = value.annotations.planning;
  const output = value.annotations.output;
  if (!isRecord(understanding) || !Array.isArray(understanding.requirements) || typeof understanding.completed !== "boolean") {
    throw new Error("理解能力标注格式无效");
  }
  assertOnlyKeys(understanding, ["requirements", "completed"], "理解能力标注");
  if (understanding.requirements.length > 30) throw new Error("理解能力需求最多 30 条");
  const requirements = understanding.requirements.map(/** 逐条收紧需求形状，避免将任意客户端字段写入评测记录。 */
  (item) => {
    if (!isRecord(item)) throw new Error("理解能力需求格式无效");
    assertOnlyKeys(item, ["requirementId", "label", "weight", "verdict"], "理解能力需求");
    const requirementId = boundedText(item.requirementId, "requirementId", 120);
    const label = boundedText(item.label, "需求内容", 500);
    if (typeof item.weight !== "number" || !Number.isFinite(item.weight) || item.weight <= 0 || item.weight > 100) {
      throw new Error("需求权重必须在 0 到 100 之间");
    }
    if (item.verdict !== "met" && item.verdict !== "missed" && item.verdict !== "unmarked") throw new Error("理解结论无效");
    return { requirementId, label, weight: item.weight, verdict: item.verdict as "met" | "missed" | "unmarked" };
  });
  if (new Set(requirements.map(/** 仅提取稳定标识，用于拒绝同一需求的重复提交。 */
  (item) => item.requirementId)).size !== requirements.length) {
    throw new Error("理解能力需求不能重复");
  }
  if (!isRecord(planning) || typeof planning.completed !== "boolean") throw new Error("规划能力标注格式无效");
  assertOnlyKeys(planning, ["score", "completed"], "规划能力标注");
  const planningScore = planning.score === undefined ? undefined : score(planning.score, "规划能力评分");
  if (planning.completed && planningScore === undefined) throw new Error("规划能力完成时必须提供评分");
  if (!isRecord(output) || !Array.isArray(output.marks) || typeof output.completed !== "boolean") {
    throw new Error("输出结果标注格式无效");
  }
  assertOnlyKeys(output, ["score", "marks", "artifactScore", "completed"], "输出结果标注");
  if (output.marks.length > 500) throw new Error("输出文字标注最多 500 条");
  const marks = output.marks.map(/** 校验文字标注区间与摘要，不信任浏览器传入的派生结果。 */
  (item) => {
    if (!isRecord(item)) throw new Error("输出文字标注格式无效");
    assertOnlyKeys(item, ["markId", "answerSectionId", "start", "end", "verdict", "quotedTextHash"], "输出文字标注");
    const answerSectionId = boundedText(item.answerSectionId, "answerSectionId", 120);
    const markId = item.markId === undefined ? undefined : boundedText(item.markId, "markId", 160);
    if (!Number.isInteger(item.start) || !Number.isInteger(item.end) || Number(item.start) < 0 || Number(item.end) <= Number(item.start)) {
      throw new Error("输出文字标注范围无效");
    }
    if (item.verdict !== "effective" && item.verdict !== "partial") throw new Error("输出文字标注结论无效");
    if (typeof item.quotedTextHash !== "string" || !/^[a-f0-9]{64}$/u.test(item.quotedTextHash)) {
      throw new Error("输出文字标注摘要无效");
    }
    return {
      ...(markId ? { markId } : {}),
      answerSectionId,
      start: Number(item.start),
      end: Number(item.end),
      verdict: item.verdict as "effective" | "partial",
      quotedTextHash: item.quotedTextHash,
    };
  });
  const outputScore = score(output.score, "输出结果评分");
  const artifactScore = output.artifactScore === undefined ? undefined : score(output.artifactScore, "产物评分");
  return {
    schemaVersion: 1,
    annotations: {
      understanding: { requirements, completed: understanding.completed },
      planning: { ...(planningScore === undefined ? {} : { score: planningScore }), completed: planning.completed },
      output: {
        score: outputScore,
        marks,
        ...(artifactScore === undefined ? {} : { artifactScore }),
        completed: output.completed,
      },
    },
  };
}

/** Evaluation 模块只接受 Runtime 生成的完整终态 Trace。 */
export function isTurnTraceDocument(value: unknown): value is TurnTraceDocument {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === 2 &&
    typeof value.traceId === "string" &&
    typeof value.runId === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.turnId === "string" &&
    (value.status === "completed" || value.status === "failed" || value.status === "cancelled") &&
    typeof value.startedAt === "number" &&
    typeof value.completedAt === "number" &&
    Array.isArray(value.modelRounds) &&
    Array.isArray(value.toolCalls) &&
    Array.isArray(value.permissions) &&
    Array.isArray(value.errors) &&
    isRecord(value.variant)
  );
}

/** Trace V1 只用于旧 Evaluation 单文件迁移和等价评分测试，不再由 Runtime 生成。 */
export interface LegacyTurnTraceDocumentV1 {
  schemaVersion: 1;
  traceId: string;
  runId: string;
  sessionId: string;
  turnId: string;
  variant: RuntimeVariantSnapshot;
  resolvedReasoning: RuntimeResolvedReasoningSnapshot;
  status: "completed" | "failed" | "cancelled";
  stopReason?: string;
  startedAt: number;
  completedAt: number;
  modelRounds: Array<Omit<ModelRoundTrace, "context" | "output"> & {
    context: {
      messages: Array<{
        role: "system" | "user" | "assistant" | "tool";
        source: ModelInputMessageTrace["source"];
        sourceId?: string;
        content: string;
        estimatedTokens: number;
      }>;
      truncatedSourceIds: string[];
      inputTokens?: number;
    };
    output?: { text: string; thinking?: string };
  }>;
  toolCalls: Array<Omit<ToolCallTrace, "arguments" | "signatureHash" | "output"> & {
    arguments: unknown;
    signature: string;
    output?: unknown;
  }>;
  permissions: PermissionTrace[];
  errors: RuntimeErrorTrace[];
}

/** V1 数据迁移入口只做外层形状识别，字段摘要由 Evaluation 模块生成。 */
export function isLegacyTurnTraceDocumentV1(value: unknown): value is LegacyTurnTraceDocumentV1 {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === 1 &&
    typeof value.traceId === "string" &&
    typeof value.runId === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.turnId === "string" &&
    (value.status === "completed" || value.status === "failed" || value.status === "cancelled") &&
    typeof value.startedAt === "number" &&
    typeof value.completedAt === "number" &&
    Array.isArray(value.modelRounds) &&
    Array.isArray(value.toolCalls) &&
    Array.isArray(value.permissions) &&
    Array.isArray(value.errors) &&
    isRecord(value.variant)
  );
}

/** 判断「isRecord」对应条件，只返回判定结果且不修改输入状态。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 收紧人工标注文本长度，避免空值或无界内容进入持久化层。 */
function boundedText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${label} 无效`);
  return value;
}

/** 评分统一使用 0～100 整数，页面展示与服务端记录保持同一量纲。 */
function score(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error(`${label} 必须是 0 到 100 的整数`);
  }
  return value;
}

/** 拒绝协议未声明字段，避免前后端版本漂移被静默吞掉。 */
function assertOnlyKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  const unknown = Object.keys(value).filter(/** 只保留协议白名单之外的字段名用于报错。 */
  (key) => !keys.includes(key));
  if (unknown.length > 0) throw new Error(`${label} 包含未知字段: ${unknown.join(", ")}`);
}
