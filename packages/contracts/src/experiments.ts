import type { BuiltinToolBinding, HistoryPolicy, McpBinding } from "./agent-management.js";
import { parseAgentInput } from "./agent-management.js";
import { isRecord, requiredString, stableJson } from "./common.js";

export interface ExperimentContextPolicy {
  systemPrompt: string;
  builtinTools: BuiltinToolBinding[];
  skillInstallationIds: string[];
  mcps: McpBinding[];
  historyPolicy: HistoryPolicy;
  memoryPolicy: { mode: "off" };
}

export interface ExperimentVariant {
  variantId: string;
  label: "A" | "B" | "C";
  mode: "rerun" | "reuse_snapshot";
  policy: ExperimentContextPolicy;
}

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

export type ExperimentStatus = "draft" | "ready" | "running" | "completed" | "partially_failed" | "failed" | "cancelled";
export type ExperimentRunStatus = "pending" | "session_created" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

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

export interface ExperimentRunRuntimeFacts {
  agentSnapshotHash?: string;
  capabilityGenerations: number;
  capabilityToolNames: string[];
  contextSources: Array<{ kind: string; title: string; estimatedTokens: number; truncated?: boolean }>;
  providerInputHash?: string;
  providerInputBytes?: number;
  usage?: import("./index.js").TurnTokenUsage;
  stopReason?: string;
}

export interface ContextPreviewInput {
  modelStudentId: string;
  promptText: string;
  policy: ExperimentContextPolicy;
  sourceTurnId?: string;
}

export interface ContextPreviewResponse {
  schemaVersion: 1;
  agentSnapshotHash: string;
  capabilityHash: string;
  contextSummary: import("./index.js").ContextSummary;
  providerInput: import("./index.js").ContextSummaryRaw;
}

export interface ExperimentRecord {
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

export type AnnotationVerdict = "effective" | "partial" | "none";

/**
 * 模型只负责把原任务和各 lane 的真实结果整理成人工标注题目，不产生 verdict 或分数。
 * 输出分段的 start/end 始终由 Remote 根据编号原文单元换算，不能直接信任模型给出的字符位置。
 */
export interface ExperimentAnnotationWorksheet {
  schemaVersion: 1;
  worksheetId: string;
  experimentId: string;
  requirements: Array<{ requirementId: string; label: string; weight: number }>;
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
    promptVersion: "annotation_worksheet_v1";
    inputHash: string;
    outputHash: string;
    generatedAt: string;
  };
}

export interface UnderstandingAnnotationFacts {
  requirements: Array<{ requirementId: string; label: string; weight: number }>;
  marks: Array<{ variantId: string; requirementId: string; verdict: "met" | "missed" }>;
  completedAt?: string;
}

export interface PlanningAnnotationFacts {
  marks: Array<{ variantId: string; stepId: string; verdict: AnnotationVerdict }>;
  completedAt?: string;
}

export interface OutputAnnotationFacts {
  marks: Array<{
    variantId: string;
    answerSectionId: string;
    start: number;
    end: number;
    verdict: AnnotationVerdict;
    quotedTextHash: string;
  }>;
  completedAt?: string;
}

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

export interface ExecutionComponentScores {
  completion: number;
  toolReliability: number;
  errorHygiene: number;
  permissionSafety: number;
  noRepeatedCalls: number;
  responsiveness: number;
}

export interface ExecutionScoreResult {
  variantId: string;
  score: number;
  metrics: ExecutionMetricsSnapshot;
  components: ExecutionComponentScores;
}

export interface ManualDimensionScores {
  complete: boolean;
  byVariant: Record<string, { understanding?: number; planning?: number; output?: number }>;
}

export interface VariantFourDimensionScore {
  variantId: string;
  dimensionScores: { understanding?: number; planning?: number; output?: number; execution: number };
  executionEvidence: { metrics: ExecutionMetricsSnapshot; componentScores: ExecutionComponentScores };
  totalScore?: number;
}

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

export function parseExperimentDraftInput(value: unknown): ExperimentDraftInput {
  if (!isRecord(value)) throw new Error("Experiment draft 必须是对象");
  if (value.mode !== "fresh_prompt" && value.mode !== "history_turn") throw new Error("Experiment mode 无效");
  if (!Array.isArray(value.variants) || value.variants.length < 2 || value.variants.length > 3) {
    throw new Error("Experiment 必须有 2 到 3 个 lane");
  }
  const variants = value.variants.map(parseVariant);
  if (new Set(variants.map((item) => item.variantId)).size !== variants.length) throw new Error("variantId 必须唯一");
  if (new Set(variants.map((item) => item.label)).size !== variants.length) throw new Error("variant label 必须唯一");
  if (value.mode === "fresh_prompt") {
    if (variants.some((item) => item.mode !== "rerun")) throw new Error("fresh 实验的 lane 必须 rerun");
    if (new Set(variants.map((item) => stableJson(item.policy))).size < 2) throw new Error("fresh 实验至少需要两个策略差异");
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

export function calculateExecutionScores(metrics: ExecutionMetricsSnapshot[]): ExecutionScoreResult[] {
  const ttftValues = metrics.flatMap((item) => item.firstTokenLatencyMs === undefined ? [] : [item.firstTokenLatencyMs]);
  const durations = metrics.map((item) => item.totalDurationMs);
  return metrics.map((item) => {
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
    const raw = Math.round(Object.values(components).reduce((sum, score) => sum + score, 0));
    return {
      variantId: item.variantId,
      score: item.normallyCompleted ? raw : Math.min(raw, 59),
      metrics: item,
      components,
    };
  });
}

export function scoreManualDimensions(input: {
  variantIds: string[];
  understanding: UnderstandingAnnotationFacts;
  planning: PlanningAnnotationFacts;
  output: OutputAnnotationFacts & { answers: Array<{ variantId: string; text: string }> };
}): ManualDimensionScores {
  const byVariant = Object.fromEntries(input.variantIds.map((id) => [id, {}])) as ManualDimensionScores["byVariant"];
  let complete = Boolean(input.understanding.completedAt && input.planning.completedAt && input.output.completedAt);
  for (const variantId of input.variantIds) {
    const understandingMarks = input.understanding.marks.filter((mark) => mark.variantId === variantId);
    const marksByRequirement = new Map(understandingMarks.map((mark) => [mark.requirementId, mark.verdict]));
    const totalWeight = input.understanding.requirements.reduce((sum, requirement) => sum + requirement.weight, 0);
    const understoodWeight = input.understanding.requirements.reduce(
      (sum, requirement) => sum + (marksByRequirement.get(requirement.requirementId) === "met" ? requirement.weight : 0),
      0,
    );
    if (totalWeight <= 0 || marksByRequirement.size !== input.understanding.requirements.length) complete = false;
    byVariant[variantId]!.understanding = totalWeight <= 0 ? 0 : Math.round(100 * understoodWeight / totalWeight);

    const planMarks = input.planning.marks.filter((mark) => mark.variantId === variantId);
    if (planMarks.length === 0) complete = false;
    byVariant[variantId]!.planning = planMarks.length === 0 ? 0 : Math.round(
      100 * planMarks.reduce((sum, mark) => sum + verdictWeight(mark.verdict), 0) / planMarks.length,
    );

    const answer = input.output.answers.find((item) => item.variantId === variantId)?.text;
    if (answer === undefined || answer.replace(/\s/gu, "").length === 0) {
      complete = false;
      byVariant[variantId]!.output = 0;
    } else {
      byVariant[variantId]!.output = scoreOutputCoverage(
        answer,
        input.output.marks.filter((mark) => mark.variantId === variantId),
      );
    }
  }
  return { complete, byVariant };
}

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
      skillInstallationIds: parsed.skillInstallationIds,
      mcps: parsed.mcps,
      historyPolicy: parsed.historyPolicy,
      memoryPolicy: parsed.memoryPolicy,
    },
  };
}

function lowerIsBetter(value: number, comparable: number[]): number {
  if (comparable.length <= 1) return 1;
  const min = Math.min(...comparable);
  const max = Math.max(...comparable);
  return min === max ? 1 : 1 - (value - min) / (max - min);
}

function verdictWeight(verdict: AnnotationVerdict): number {
  return verdict === "effective" ? 1 : verdict === "partial" ? 0.5 : 0;
}

function scoreOutputCoverage(text: string, marks: OutputAnnotationFacts["marks"]): number {
  const weights = Array.from({ length: text.length }, () => 0);
  for (const mark of marks) {
    const start = Math.max(0, Math.min(text.length, Math.trunc(mark.start)));
    const end = Math.max(start, Math.min(text.length, Math.trunc(mark.end)));
    const weight = verdictWeight(mark.verdict);
    for (let index = start; index < end; index += 1) weights[index] = Math.max(weights[index] ?? 0, weight);
  }
  let total = 0;
  let earned = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (/\s/u.test(text[index] ?? "")) continue;
    total += 1;
    earned += weights[index] ?? 0;
  }
  return total === 0 ? 0 : Math.round(100 * earned / total);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
