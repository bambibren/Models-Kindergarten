import type { BuiltinToolBinding, HistoryPolicy, McpBinding } from "./agent-management.js";
import { parseAgentInput } from "./agent-management.js";
import { isRecord, requiredString, stableJson } from "./common.js";
import type { ReasoningProfile, ResolvedReasoningSnapshot } from "./reasoning.js";
import { parseReasoningProfile } from "./reasoning.js";
import type { ArtifactMentionInput } from "./artifacts.js";

/** 描述「ExperimentContextPolicy」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ExperimentContextPolicy {
  systemPrompt: string;
  builtinTools: BuiltinToolBinding[];
  builtinSkillIds: string[];
  skillInstallationIds: string[];
  mcps: McpBinding[];
  historyPolicy: HistoryPolicy;
  memoryPolicy: { mode: "off" };
}

/** 描述「ExperimentVariant」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ExperimentVariant {
  variantId: string;
  label: "A" | "B" | "C";
  mode: "rerun" | "reuse_snapshot";
  policy: ExperimentContextPolicy;
}

/** 描述「ExperimentDraftInput」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ExperimentDraftInput {
  name: string;
  mode: "fresh_prompt" | "history_turn";
  modelStudentId: string;
  sourceAgentId: string;
  promptText: string;
  sourceTurnId?: string;
  toolUseWasExpected: boolean;
  variants: ExperimentVariant[];
}

/** 描述「ExperimentStatus」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ExperimentStatus = "draft" | "ready" | "running" | "completed" | "partially_failed" | "failed" | "cancelled";
/** 描述「ExperimentRunStatus」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ExperimentRunStatus = "pending" | "session_created" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

/** 描述「ExperimentRun」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ExperimentRun {
  runId: string;
  variantId: string;
  agentId: string;
  mode: "rerun" | "reuse_snapshot";
  status: ExperimentRunStatus;
  acpSessionId?: string;
  turnId?: string;
  reusedTurnId?: string;
  answerTexts: string[];
  executionMetrics?: ExecutionMetricsSnapshot;
  runtimeFacts?: ExperimentRunRuntimeFacts;
  error?: import("./common.js").PublicErrorRef;
  startedAt?: string;
  completedAt?: string;
}

/** 描述「ExperimentRunRuntimeFacts」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ExperimentRunRuntimeFacts {
  agentSnapshotHash?: string;
  capabilityGenerations: number;
  capabilityToolNames: string[];
  contextSources: Array<{ kind: string; title: string; estimatedTokens: number; truncated?: boolean }>;
  modelRounds?: Array<{
    roundIndex: number;
    capabilityGeneration: number;
    contextSummary: import("./index.js").ContextSummary;
    providerInput?: import("./index.js").ContextSummaryRaw;
    providerInputHash?: string;
    providerInputBytes?: number;
    resolvedReasoning?: ResolvedReasoningSnapshot;
  }>;
  providerInputHash?: string;
  providerInputBytes?: number;
  usage?: import("./index.js").TurnTokenUsage;
  stopReason?: string;
}

/** 描述「ContextPreviewInput」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ContextPreviewInput {
  modelStudentId: string;
  promptText: string;
  policy: ExperimentContextPolicy;
  sourceTurnId?: string;
}

/** 描述「ContextPreviewResponse」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ContextPreviewResponse {
  schemaVersion: 1;
  agentSnapshotHash: string;
  capabilityHash: string;
  contextSummary: import("./index.js").ContextSummary;
  providerInput: import("./index.js").ContextSummaryRaw;
}

/** 旧实验只读合同；V2 写入路径不得创建或修改这种记录。 */
export interface LegacyExperimentRecordV1 {
  schemaVersion: 1;
  experimentId: string;
  ownerId: string;
  name: string;
  mode: "fresh_prompt" | "history_turn";
  status: ExperimentStatus;
  modelStudentId: string;
  sourceAgentId: string;
  promptText: string;
  sourceTurnId?: string;
  toolUseWasExpected: boolean;
  variants: ExperimentVariant[];
  runs: ExperimentRun[];
  annotationWorksheet?: ExperimentAnnotationWorksheet;
  savedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** @deprecated 新代码应显式使用 LegacyExperimentRecordV1 或 AnyExperimentRecord。 */
export type ExperimentRecord = LegacyExperimentRecordV1;

/** 描述「ExperimentSourceAgentRefV2」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ExperimentSourceAgentRefV2 {
  agentId: string;
  name: string;
  updatedAt: string;
}

/** 描述「ExperimentTestDraftV2」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ExperimentTestDraftV2 {
  testId: string;
  label: "A" | "B" | "C";
  sourceAgent: ExperimentSourceAgentRefV2;
  modelStudentId: string;
  reasoningProfile: ReasoningProfile;
  policy: ExperimentContextPolicy;
}

/** 描述「ExperimentDraftV2」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ExperimentDraftV2 {
  schemaVersion: 2;
  name: string;
  promptText: string;
  artifactMentions?: ArtifactMentionInput[];
  sourceRef?: { kind: "turn"; id: string };
  toolUseWasExpected: boolean;
  tests: ExperimentTestDraftV2[];
}

/** 描述「ExperimentTestSnapshotV2」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ExperimentTestSnapshotV2 {
  snapshotId: string;
  testId: string;
  label: "A" | "B" | "C";
  sourceAgent: ExperimentSourceAgentRefV2;
  policy: ExperimentContextPolicy;
  agentSnapshotHash: string;
  model: {
    modelStudentId: string;
    providerKind: string;
    model: string;
    capabilityHash: string;
    contextWindowTokens?: number;
  };
  reasoning: ResolvedReasoningSnapshot;
  dependencies: Array<{
    kind: "skill" | "mcp";
    id: string;
    generation?: number;
    contentHash: string;
  }>;
  runtimePrompt: { version: "runtime_system_prompt_v1"; hash: string };
  firstRequestPreview: {
    contextHash: string;
    providerInputHash: string;
    providerInputBytes: number;
    estimatedTokens: number;
    actualHistoryTurns: 0;
  };
  effectiveConfigurationHash: string;
  frozenAt: string;
}

/** 描述「ExperimentRunV2」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ExperimentRunV2 {
  runId: string;
  testId: string;
  snapshotId: string;
  status: ExperimentRunStatus;
  acpSessionId?: string;
  turnId?: string;
  answerTexts: string[];
  executionMetrics?: ExecutionMetricsSnapshot;
  runtimeFacts?: ExperimentRunRuntimeFacts;
  error?: import("./common.js").PublicErrorRef;
  startedAt?: string;
  completedAt?: string;
  hadHumanIntervention?: boolean;
  interventions?: ExperimentInterventionFact[];
}

/** 描述「ExperimentInterventionFact」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ExperimentInterventionFact {
  interactionId: string;
  kind: "permission" | "elicitation";
  summary: string;
  decision: string;
  operatorId: string;
  resolvedAt: string;
}

/** 描述「ExperimentRecordV2」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ExperimentRecordV2 {
  schemaVersion: 2;
  experimentId: string;
  ownerId: string;
  name: string;
  status: "draft" | "prepared" | "running" | "completed" | "partially_failed" | "failed" | "cancelled" | "interrupted";
  promptText: string;
  artifactMentions?: ArtifactMentionInput[];
  sourceRef?: { kind: "turn"; id: string };
  toolUseWasExpected: boolean;
  worksheetModelStudentId: string;
  tests: ExperimentTestDraftV2[];
  snapshots?: ExperimentTestSnapshotV2[];
  runs: ExperimentRunV2[];
  prepareKey?: string;
  annotationWorksheet?: ExperimentAnnotationWorksheet;
  savedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** 描述「AnyExperimentRecord」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type AnyExperimentRecord = LegacyExperimentRecordV1 | ExperimentRecordV2;

/** 描述「ContextPreviewInputV2」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ContextPreviewInputV2 {
  schemaVersion: 2;
  promptText: string;
  artifactMentions?: ArtifactMentionInput[];
  test: ExperimentTestDraftV2;
}

/** 描述「ContextPreviewDiagnostic」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ContextPreviewDiagnostic {
  code: string;
  message: string;
  path?: string;
}

/** 描述「ContextPreviewResponseV2」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ContextPreviewResponseV2 {
  schemaVersion: 2;
  runnable: boolean;
  diagnostics: ContextPreviewDiagnostic[];
  agentSnapshotHash: string;
  capabilityHash: string;
  effectiveConfigurationHash: string;
  contextSummary: import("./index.js").ContextSummary;
  providerInput: import("./index.js").ContextSummaryRaw;
  providerInputHash: string;
  providerInputBytes: number;
  resolvedReasoning: ResolvedReasoningSnapshot;
  model: {
    modelStudentId: string;
    displayName: string;
    providerKind: string;
    model: string;
    contextWindowTokens?: number;
  };
  history: {
    configuredPolicy: HistoryPolicy;
    actualHistoryTurns: 0;
  };
}

/** 描述「AnnotationVerdict」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type AnnotationVerdict = "effective" | "partial" | "none";

/**
 * 模型只负责把原任务和各 lane 的真实结果整理成人工标注题目，不产生 verdict 或分数。
 * 输出分段的 start/end 始终由 Remote 根据编号原文单元换算，不能直接信任模型给出的字符位置。
 */
export interface ExperimentAnnotationWorksheet {
  schemaVersion: 1;
  worksheetId: string;
  experimentId: string;
  requirements: Array<{
    requirementId: string;
    label: string;
    weight: number;
    /** 只记录需求在用户 Prompt 或各 lane 首次思考中的事实来源，不代表人工 verdict。旧工作表可缺失。 */
    sourceVariantIds?: string[];
    /** 只记录各 lane 首次思考是否明确识别该需求，最终是否理解到仍由人工判断。旧工作表可缺失。 */
    matchedVariantIds?: string[];
  }>;
  workflows: Array<{
    variantId: string;
    steps: Array<{ stepId: string; label: string }>;
  }>;
  outputSections: Array<{
    variantId: string;
    sections: Array<{
      answerSectionId: string;
      label: string;
      start: number;
      end: number;
      quotedTextHash: string;
      preview: string;
    }>;
  }>;
  generator: {
    modelStudentId: string;
    providerKind: string;
    model: string;
    promptVersion: "annotation_worksheet_v1" | "annotation_worksheet_v2" | "annotation_worksheet_v3" | "annotation_worksheet_v4" | "annotation_worksheet_v5";
    inputHash: string;
    outputHash: string;
    generatedAt: string;
  };
}

/** 描述「UnderstandingAnnotationFacts」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface UnderstandingAnnotationFacts {
  requirements: Array<{ requirementId: string; label: string; weight: number }>;
  marks: Array<{ variantId: string; requirementId: string; verdict: "met" | "missed" }>;
  completedAt?: string;
}

/** 描述「PlanningAnnotationFacts」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface PlanningAnnotationFacts {
  /** Workflow 只提供观察材料；规划分完全来自人工滑块，不由提取器推导。 */
  scores: Array<{ variantId: string; score: number }>;
  completedAt?: string;
}

/** 描述「OutputAnnotationFacts」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface OutputAnnotationFacts {
  marks: Array<{
    /** 任意文字选区允许同一语义段内存在多条标注；旧整段标注可缺失。 */
    markId?: string;
    variantId: string;
    answerSectionId: string;
    start: number;
    end: number;
    verdict: AnnotationVerdict;
    quotedTextHash: string;
  }>;
  /** 同一 lane 的全部已发布产物共用一个人工分，避免多产物把输出维度抬高到 100 以上。 */
  artifactScores?: Array<{
    variantId: string;
    score: number;
  }>;
  completedAt?: string;
}

/** 描述「ExecutionMetricsSnapshot」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ExecutionMetricsSnapshot {
  evaluationRecordId: string;
  variantId: string;
  normallyCompleted: boolean;
  firstTokenLatencyMs?: number;
  totalDurationMs: number;
  toolUseWasExpected: boolean;
  toolSuccessCount: number;
  toolFailureCount: number;
  errorCount: number;
  permissionViolationCount: number;
  hasRepeatedToolCall: boolean;
  modelRoundCount: number;
  toolCallCount: number;
  totalContextTokens: number;
  totalOutputTokens: number;
}

/** 描述「ExecutionComponentScores」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ExecutionComponentScores {
  completion: number;
  toolReliability: number;
  errorHygiene: number;
  permissionSafety: number;
  noRepeatedCalls: number;
  responsiveness: number;
}

/** 描述「ExecutionScoreResult」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ExecutionScoreResult {
  variantId: string;
  score: number;
  metrics: ExecutionMetricsSnapshot;
  components: ExecutionComponentScores;
}

/** 描述「ManualDimensionScores」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ManualDimensionScores {
  complete: boolean;
  byVariant: Record<string, { understanding?: number; planning?: number; output?: number }>;
}

/** 描述「VariantFourDimensionScore」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface VariantFourDimensionScore {
  variantId: string;
  /** 旧 scorecard 可缺失；新写入使用该 ID 关联独立原子评分记录。 */
  scoreResultId?: string;
  dimensionScores: { understanding?: number; planning?: number; output?: number; execution: number };
  executionEvidence: { metrics: ExecutionMetricsSnapshot; componentScores: ExecutionComponentScores };
  totalScore?: number;
}

/** 描述「ExperimentScorecard」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ExperimentScorecard {
  schemaVersion: 1;
  scorecardId: string;
  experimentId: string;
  rubric: {
    rubricId: "context_experiment_four_dimensions";
    rubricVersion: 1;
    dimensions: [
      { id: "understanding"; source: "manual_annotation"; weight: 0.25 },
      { id: "planning"; source: "manual_annotation"; weight: 0.25 },
      { id: "output"; source: "manual_annotation"; weight: 0.25 },
      { id: "execution"; source: "runtime_metrics"; weight: 0.25 },
    ];
    executionPolicy: { policyId: "runtime_execution_v1"; policyVersion: 1 };
  };
  annotations: {
    understanding: UnderstandingAnnotationFacts;
    planning: PlanningAnnotationFacts;
    output: OutputAnnotationFacts;
  };
  variants: VariantFourDimensionScore[];
  ranking?: Array<{ rank: number; variantIds: string[]; totalScore: number }>;
  winnerVariantIds?: string[];
  status: "draft" | "complete";
  createdAt: string;
  updatedAt: string;
}

/** 校验并规范化「parseExperimentDraftInput」输入，非法数据直接返回明确错误。 */
export function parseExperimentDraftInput(value: unknown): ExperimentDraftInput {
  if (!isRecord(value)) throw new Error("Experiment draft 必须是对象");
  if (value.mode !== "fresh_prompt" && value.mode !== "history_turn") throw new Error("Experiment mode 无效");
  if (!Array.isArray(value.variants) || value.variants.length < 2 || value.variants.length > 3) {
    throw new Error("Experiment 必须有 2 到 3 个 lane");
  }
  const variants = value.variants.map(parseVariant);
  if (new Set(variants.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.variantId)).size !== variants.length) throw new Error("variantId 必须唯一");
  if (new Set(variants.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.label)).size !== variants.length) throw new Error("variant label 必须唯一");
  if (value.mode === "fresh_prompt") {
    if (variants.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.mode !== "rerun")) throw new Error("fresh 实验的 lane 必须 rerun");
    if (new Set(variants.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => stableJson(item.policy))).size < 2) throw new Error("fresh 实验至少需要两个策略差异");
  }
  const sourceTurnId = typeof value.sourceTurnId === "string" && value.sourceTurnId.length > 0 ? value.sourceTurnId : undefined;
  if (value.mode === "history_turn" && (!sourceTurnId || variants[0]?.mode !== "reuse_snapshot")) {
    throw new Error("history 实验需要 sourceTurnId，且 A lane 必须复用原始快照");
  }
  return {
    name: requiredString(value, "name", { max: 120 }),
    mode: value.mode,
    modelStudentId: requiredString(value, "modelStudentId", { max: 160 }),
    sourceAgentId: requiredString(value, "sourceAgentId", { max: 160 }),
    promptText: requiredString(value, "promptText", { max: 100_000 }),
    ...(sourceTurnId ? { sourceTurnId } : {}),
    toolUseWasExpected: value.toolUseWasExpected === true,
    variants,
  };
}

/** 校验并规范化「parseExperimentDraftV2」输入，非法数据直接返回明确错误。 */
export function parseExperimentDraftV2(value: unknown): ExperimentDraftV2 {
  if (!isRecord(value)) throw new Error("Experiment V2 draft 必须是对象");
  assertOnlyKeys(value, ["schemaVersion", "name", "promptText", "artifactMentions", "sourceRef", "toolUseWasExpected", "tests"], "Experiment V2 draft");
  if (value.schemaVersion !== 2) throw new Error("Experiment V2 schemaVersion 必须为 2");
  if (!Array.isArray(value.tests) || value.tests.length < 2 || value.tests.length > 3) {
    throw new Error("Experiment V2 必须有 2 到 3 个 Test");
  }
  const tests = value.tests.map(parseExperimentTestDraftV2);
  if (new Set(tests.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.testId)).size !== tests.length) throw new Error("testId 必须唯一");
  if (new Set(tests.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.label)).size !== tests.length) throw new Error("Test label 必须唯一");
  const expectedLabels = tests.length === 2 ? ["A", "B"] : ["A", "B", "C"];
  if (tests.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item, index) => item.label !== expectedLabels[index])) throw new Error("Test 必须按 A、B、C 排列");
  let sourceRef: ExperimentDraftV2["sourceRef"];
  if (value.sourceRef !== undefined) {
    if (!isRecord(value.sourceRef)) throw new Error("sourceRef 格式无效");
    assertOnlyKeys(value.sourceRef, ["kind", "id"], "sourceRef");
    if (value.sourceRef.kind !== "turn") throw new Error("sourceRef.kind 必须是 turn");
    sourceRef = { kind: "turn", id: requiredString(value.sourceRef, "id", { max: 160 }) };
  }
  return {
    schemaVersion: 2,
    name: requiredString(value, "name", { max: 120 }),
    promptText: requiredString(value, "promptText", { max: 100_000 }),
    ...parseArtifactMentions(value.artifactMentions),
    ...(sourceRef ? { sourceRef } : {}),
    toolUseWasExpected: value.toolUseWasExpected === true,
    tests,
  };
}

/** 校验并规范化「parseContextPreviewInputV2」输入，非法数据直接返回明确错误。 */
export function parseContextPreviewInputV2(value: unknown): ContextPreviewInputV2 {
  if (!isRecord(value)) throw new Error("Context Preview V2 输入必须是对象");
  assertOnlyKeys(value, ["schemaVersion", "promptText", "artifactMentions", "test"], "Context Preview V2");
  if (value.schemaVersion !== 2) throw new Error("Context Preview V2 schemaVersion 必须为 2");
  return {
    schemaVersion: 2,
    promptText: requiredString(value, "promptText", { max: 100_000 }),
    ...parseArtifactMentions(value.artifactMentions),
    test: parseExperimentTestDraftV2(value.test),
  };
}

/** Artifact Mention 只接受稳定 ID，并拒绝重复引用和额外展示字段。 */
function parseArtifactMentions(value: unknown): { artifactMentions?: ArtifactMentionInput[] } {
  if (value === undefined) return {};
  if (!Array.isArray(value)) throw new Error("artifactMentions 必须是数组");
  const artifactMentions = value.map((item) => {
    if (!isRecord(item)) throw new Error("Artifact Mention 必须是对象");
    assertOnlyKeys(item, ["artifactId"], "Artifact Mention");
    return { artifactId: requiredString(item, "artifactId", { max: 160 }) };
  });
  if (new Set(artifactMentions.map((item) => item.artifactId)).size !== artifactMentions.length) {
    throw new Error("artifactMentions 不能重复");
  }
  return artifactMentions.length > 0 ? { artifactMentions } : {};
}

/** 校验并规范化「parseExperimentTestDraftV2」输入，非法数据直接返回明确错误。 */
function parseExperimentTestDraftV2(value: unknown): ExperimentTestDraftV2 {
  if (!isRecord(value)) throw new Error("Experiment Test 必须是对象");
  assertOnlyKeys(value, ["testId", "label", "sourceAgent", "modelStudentId", "reasoningProfile", "policy"], "Experiment Test");
  if (value.label !== "A" && value.label !== "B" && value.label !== "C") throw new Error("Test label 必须为 A/B/C");
  if (!isRecord(value.sourceAgent)) throw new Error("sourceAgent 格式无效");
  assertOnlyKeys(value.sourceAgent, ["agentId", "name", "updatedAt"], "sourceAgent");
  if (!isRecord(value.policy)) throw new Error("Test policy 必须是对象");
  const parsed = parseAgentInput({ name: "experiment-policy", ...value.policy });
  return {
    testId: requiredString(value, "testId", { max: 120 }),
    label: value.label,
    sourceAgent: {
      agentId: requiredString(value.sourceAgent, "agentId", { max: 160 }),
      name: requiredString(value.sourceAgent, "name", { max: 120 }),
      updatedAt: requiredString(value.sourceAgent, "updatedAt", { max: 80 }),
    },
    modelStudentId: requiredString(value, "modelStudentId", { max: 160 }),
    reasoningProfile: parseReasoningProfile(value.reasoningProfile),
    policy: {
      systemPrompt: parsed.systemPrompt,
      builtinTools: parsed.builtinTools,
      builtinSkillIds: parsed.builtinSkillIds,
      skillInstallationIds: parsed.skillInstallationIds,
      mcps: parsed.mcps,
      historyPolicy: parsed.historyPolicy,
      memoryPolicy: parsed.memoryPolicy,
    },
  };
}

/** 执行「calculateExecutionScores」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function calculateExecutionScores(metrics: ExecutionMetricsSnapshot[]): ExecutionScoreResult[] {
  const ttftValues = metrics.flatMap(/** 执行「ttftValues」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(item) => item.firstTokenLatencyMs === undefined ? [] : [item.firstTokenLatencyMs]);
  const durations = metrics.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.totalDurationMs);
  return metrics.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => {
    const totalTools = item.toolSuccessCount + item.toolFailureCount;
    const toolReliability = item.toolCallCount === 0 && !item.toolUseWasExpected
      ? 25
      : totalTools === 0 ? 0 : 25 * item.toolSuccessCount / totalTools;
    const ttft = item.firstTokenLatencyMs === undefined ? 0 : 5 * lowerIsBetter(item.firstTokenLatencyMs, ttftValues);
    const duration = 5 * lowerIsBetter(item.totalDurationMs, durations);
    const components: ExecutionComponentScores = {
      completion: item.normallyCompleted ? 30 : 0,
      toolReliability: round2(toolReliability),
      errorHygiene: Math.max(0, 15 - 5 * item.errorCount),
      permissionSafety: item.permissionViolationCount === 0 ? 15 : 0,
      noRepeatedCalls: item.hasRepeatedToolCall ? 0 : 5,
      responsiveness: round2(ttft + duration),
    };
    const raw = Math.round(Object.values(components).reduce(/** 把当前元素归并到有限累加状态，避免额外复制完整集合。 */
(sum, score) => sum + score, 0));
    return {
      variantId: item.variantId,
      score: item.normallyCompleted ? raw : Math.min(raw, 59),
      metrics: item,
      components,
    };
  });
}

/** 执行「scoreManualDimensions」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function scoreManualDimensions(input: {
  variantIds: string[];
  understanding: UnderstandingAnnotationFacts;
  planning: PlanningAnnotationFacts;
  output: OutputAnnotationFacts & {
    answers: Array<{ variantId: string; text: string }>;
    artifactVariantIds?: string[];
  };
}): ManualDimensionScores {
  const byVariant = Object.fromEntries(input.variantIds.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(id) => [id, {}])) as ManualDimensionScores["byVariant"];
  let complete = Boolean(input.understanding.completedAt && input.planning.completedAt && input.output.completedAt);
  for (const variantId of input.variantIds) {
    const understandingMarks = input.understanding.marks.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(mark) => mark.variantId === variantId);
    const marksByRequirement = new Map(understandingMarks.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(mark) => [mark.requirementId, mark.verdict]));
    const totalWeight = input.understanding.requirements.reduce(/** 把当前元素归并到有限累加状态，避免额外复制完整集合。 */
(sum, requirement) => sum + requirement.weight, 0);
    const understoodWeight = input.understanding.requirements.reduce(
      /** 把当前元素归并到有限累加状态，避免额外复制完整集合。 */
(sum, requirement) => sum + (marksByRequirement.get(requirement.requirementId) === "met" ? requirement.weight : 0),
      0,
    );
    if (totalWeight <= 0 || marksByRequirement.size !== input.understanding.requirements.length) complete = false;
    byVariant[variantId]!.understanding = totalWeight <= 0 ? 0 : Math.round(100 * understoodWeight / totalWeight);

    const planningScore = input.planning.scores.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.variantId === variantId);
    if (!planningScore) complete = false;
    else byVariant[variantId]!.planning = planningScore.score;

    const artifactScore = input.output.artifactVariantIds?.includes(variantId)
      ? input.output.artifactScores?.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.variantId === variantId)
      : undefined;
    if (input.output.artifactVariantIds?.includes(variantId)) {
      if (!artifactScore) complete = false;
      byVariant[variantId]!.output = artifactScore?.score ?? 0;
      continue;
    }
    const answer = input.output.answers.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.variantId === variantId)?.text;
    if (answer === undefined || answer.replace(/\s/gu, "").length === 0) {
      complete = false;
      byVariant[variantId]!.output = 0;
    } else {
      byVariant[variantId]!.output = scoreOutputCoverage(
        answer,
        input.output.marks.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(mark) => mark.variantId === variantId),
      );
    }
  }
  return { complete, byVariant };
}

/** 校验并规范化「parseVariant」输入，非法数据直接返回明确错误。 */
function parseVariant(value: unknown): ExperimentVariant {
  if (!isRecord(value)) throw new Error("Experiment variant 必须是对象");
  if (value.label !== "A" && value.label !== "B" && value.label !== "C") throw new Error("variant label 必须为 A/B/C");
  if (value.mode !== "rerun" && value.mode !== "reuse_snapshot") throw new Error("variant mode 无效");
  if (!isRecord(value.policy)) throw new Error("variant policy 必须是对象");
  const parsed = parseAgentInput({ name: "experiment-policy", ...value.policy });
  return {
    variantId: requiredString(value, "variantId", { max: 120 }),
    label: value.label,
    mode: value.mode,
    policy: {
      systemPrompt: parsed.systemPrompt,
      builtinTools: parsed.builtinTools,
      builtinSkillIds: parsed.builtinSkillIds,
      skillInstallationIds: parsed.skillInstallationIds,
      mcps: parsed.mcps,
      historyPolicy: parsed.historyPolicy,
      memoryPolicy: parsed.memoryPolicy,
    },
  };
}

/** 执行「lowerIsBetter」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function lowerIsBetter(value: number, comparable: number[]): number {
  if (comparable.length <= 1) return 1;
  const min = Math.min(...comparable);
  const max = Math.max(...comparable);
  return min === max ? 1 : 1 - (value - min) / (max - min);
}

/** 执行「verdictWeight」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function verdictWeight(verdict: AnnotationVerdict): number {
  return verdict === "effective" ? 1 : verdict === "partial" ? 0.5 : 0;
}

/** 执行「scoreOutputCoverage」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function scoreOutputCoverage(text: string, marks: OutputAnnotationFacts["marks"]): number {
  const intervals = marks.flatMap(/** 执行「intervals」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(mark) => {
    const start = Math.max(0, Math.min(text.length, Math.trunc(mark.start)));
    const end = Math.max(start, Math.min(text.length, Math.trunc(mark.end)));
    const weight = verdictWeight(mark.verdict);
    return start < end && weight > 0 ? [{ start, end, weight }] : [];
  });
  const starts = intervals.toSorted(/** 执行「starts」主流程，传播取消与失败并在结束时清理临时资源。 */
(left, right) => left.start - right.start);
  const ends = intervals.toSorted(/** 执行「ends」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(left, right) => left.end - right.end);
  let startIndex = 0;
  let endIndex = 0;
  let fullWeight = 0;
  let partialWeight = 0;
  let total = 0;
  let earned = 0;
  for (let index = 0; index < text.length; index += 1) {
    while ((ends[endIndex]?.end ?? Number.POSITIVE_INFINITY) <= index) {
      if (ends[endIndex]?.weight === 1) fullWeight -= 1;
      else partialWeight -= 1;
      endIndex += 1;
    }
    while ((starts[startIndex]?.start ?? Number.POSITIVE_INFINITY) <= index) {
      if (starts[startIndex]?.weight === 1) fullWeight += 1;
      else partialWeight += 1;
      startIndex += 1;
    }
    if (/\s/u.test(text[index] ?? "")) continue;
    total += 1;
    earned += fullWeight > 0 ? 1 : partialWeight > 0 ? 0.5 : 0;
  }
  return total === 0 ? 0 : Math.round(100 * earned / total);
}

/** 执行「round2」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 校验并规范化「assertOnlyKeys」输入，非法数据直接返回明确错误。 */
function assertOnlyKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unknown = Object.keys(value).filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${label} 包含未知字段: ${unknown.join(", ")}`);
}
