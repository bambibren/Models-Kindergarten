import { createHash } from "node:crypto";
import { stableJson } from "@kindergarten/contracts";
import type {
  ModelAgentScoreGroupDetail,
  ModelAgentScoreGroupSummary,
  ScoreResultRecord,
  ScoreResultSource,
  ScoreResultUpsertInput,
} from "@kindergarten/evaluation-contract";

/** 从统一写入事实构造稳定原子评分；同一来源重复保存只更新同一 ID。 */
export function buildScoreResult(input: ScoreResultUpsertInput, current?: ScoreResultRecord): ScoreResultRecord {
  const scoreResultId = scoreResultIdForSource(input.source);
  if (current && (current.scoreResultId !== scoreResultId || !sameSource(current.source, input.source))) {
    throw new Error("原子评分 ID 与来源事实不一致");
  }
  const configurationHash = scoreConfigurationHash(input.agentConfiguration);
  const dimensions = structuredClone(input.dimensionScores);
  const complete = input.completed && dimensions.understanding !== undefined &&
    dimensions.planning !== undefined && dimensions.output !== undefined;
  const totalScore = complete
    ? roundScore((dimensions.understanding! + dimensions.planning! + dimensions.output! + dimensions.execution) / 4)
    : undefined;
  const now = input.recordedAt ?? new Date().toISOString();
  return {
    schemaVersion: 1,
    scoreResultId,
    ownerId: input.ownerId,
    modelStudentId: input.modelStudentId,
    source: structuredClone(input.source),
    sourceTitle: input.sourceTitle,
    agentConfiguration: {
      ...structuredClone(input.agentConfiguration),
      configurationHash,
    },
    dimensionScores: dimensions,
    status: complete ? "complete" : "draft",
    ...(totalScore === undefined ? {} : { totalScore }),
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
  };
}

/** 来源 ID 只参与哈希，不直接暴露为分片文件名或跨域定位符。 */
export function scoreResultIdForSource(source: ScoreResultSource): string {
  return `score_${createHash("sha256").update(stableJson(sourceIdentity(source))).digest("hex")}`;
}

/** 聚合键排除可变 Agent 名称/ID，并包含实际生效的思考配置。 */
export function scoreConfigurationHash(
  configuration: ScoreResultUpsertInput["agentConfiguration"],
): string {
  return createHash("sha256").update(stableJson({
    systemPrompt: configuration.systemPrompt,
    builtinTools: configuration.builtinTools.toSorted((left, right) => left.toolId.localeCompare(right.toolId)),
    builtinSkills: configuration.builtinSkills.toSorted((left, right) => left.skillId.localeCompare(right.skillId)),
    skills: configuration.skills.toSorted((left, right) => left.skillInstallationId.localeCompare(right.skillInstallationId)),
    mcps: configuration.mcps.toSorted((left, right) => left.mcpInstallationId.localeCompare(right.mcpInstallationId)).map((mcp) => ({
      ...mcp,
      tools: mcp.tools.toSorted((left, right) => left.remoteName.localeCompare(right.remoteName)),
      resources: mcp.resources.toSorted((left, right) => left.uri.localeCompare(right.uri)),
    })),
    historyPolicy: configuration.historyPolicy,
    memoryPolicy: configuration.memoryPolicy,
    reasoning: {
      resolvedProfile: configuration.reasoning.resolvedProfile,
      native: configuration.reasoning.native,
    },
  })).digest("hex");
}

/** 只让完整四维结果进入模型排行，平均分保留一位小数。 */
export function aggregateModelScoreGroups(
  records: ScoreResultRecord[],
  ownerId: string,
  modelStudentId: string,
): ModelAgentScoreGroupSummary[] {
  const groups = new Map<string, ScoreResultRecord[]>();
  for (const record of records) {
    if (record.ownerId !== ownerId || record.modelStudentId !== modelStudentId ||
      record.status !== "complete" || record.totalScore === undefined) continue;
    const key = record.agentConfiguration.configurationHash;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return [...groups.entries()].map(/** 同一配置的完整原子评分压缩为一条排名记录。 */
  ([configurationHash, values]) => {
    const sorted = values.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const scores = values.map((value) => value.totalScore!);
    return {
      configurationHash,
      agentName: sorted[0]!.agentConfiguration.agentName,
      sampleCount: scores.length,
      averageScore: roundScore(scores.reduce((sum, score) => sum + score, 0) / scores.length),
      minScore: Math.min(...scores),
      maxScore: Math.max(...scores),
      lastScoredAt: sorted[0]!.updatedAt,
    };
  }).toSorted(/** 排名先按平均分降序，同分时优先最近产生证据的配置。 */
  (left, right) => right.averageScore - left.averageScore || right.lastScoredAt.localeCompare(left.lastScoredAt));
}

/** 返回一组配置快照及其完整评分历史，历史项保持原子 ID。 */
export function modelScoreGroupDetail(
  records: ScoreResultRecord[],
  ownerId: string,
  modelStudentId: string,
  configurationHash: string,
): ModelAgentScoreGroupDetail | undefined {
  const summary = aggregateModelScoreGroups(records, ownerId, modelStudentId)
    .find((item) => item.configurationHash === configurationHash);
  if (!summary) return undefined;
  const history = records.filter((record) => record.ownerId === ownerId &&
    record.modelStudentId === modelStudentId && record.status === "complete" &&
    record.agentConfiguration.configurationHash === configurationHash)
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return { summary, configuration: structuredClone(history[0]!.agentConfiguration), history: structuredClone(history) };
}

/** 不同来源类型分别定义稳定业务主键，显示标题和 scorecardId 不影响原子身份。 */
function sourceIdentity(source: ScoreResultSource): object {
  return source.kind === "context_experiment"
    ? { kind: source.kind, experimentId: source.experimentId, testId: source.testId }
    : { kind: source.kind, sessionId: source.sessionId, turnId: source.turnId };
}

/** 防止哈希碰撞或调用错误把原子评分覆盖到另一条来源。 */
function sameSource(left: ScoreResultSource, right: ScoreResultSource): boolean {
  return stableJson(sourceIdentity(left)) === stableJson(sourceIdentity(right));
}

/** 排行与页面统一使用一位小数，整数不会附带无意义尾零。 */
function roundScore(value: number): number {
  return Math.round(value * 10) / 10;
}
