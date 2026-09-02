import { calculateExecutionScores } from "@kindergarten/contracts";
import { parseTurnEffectScoreDraft, type ScoreResultUpsertInput } from "@kindergarten/evaluation-contract";
import type { SessionRepository } from "../repository/session-repository.js";
import type { AgentService } from "../agent/agent-service.js";
import { ApiProblemError } from "../server/api-problem.js";
import type { ControlRouter } from "../server/control-router.js";
import type { EvaluationModule } from "./evaluation-module.js";

/** 效果打分走 Control API，复用登录、同源写保护和账号归属校验。 */
export function registerTurnEffectScoreRoutes(
  router: ControlRouter,
  sessions: SessionRepository,
  evaluation: EvaluationModule,
  agents: AgentService,
): void {
  router.register("GET", "/turns/:turnId/effect-score", /** 读取前先以登录账号核验 Turn 归属和终态。 */
  async ({ params, principal }) => {
    const found = await requireCompletedTurn(sessions, params.turnId ?? "", principal.principalId);
    return await evaluation.getEffectScore(found.session.id, found.turn.turnId) ?? null;
  });
  router.register("PUT", "/turns/:turnId/effect-score", /** 写入只接受已完成聊天 Turn，并复用客观执行分。 */
  async ({ params, principal, json }) => {
    const found = await requireCompletedTurn(sessions, params.turnId ?? "", principal.principalId);
    let draft;
    try {
      draft = parseTurnEffectScoreDraft(await json());
    } catch (error) {
      throw new ApiProblemError(400, "VALIDATION_FAILED", error instanceof Error ? error.message : "效果打分格式无效", false);
    }
    const record = await evaluation.get(found.session.id, found.turn.turnId);
    if (!record) throw new ApiProblemError(409, "SCORECARD_INCOMPLETE", "本轮 Runtime Evaluation 尚未生成", true);
    const metrics = record.result;
    const execution = calculateExecutionScores([{
      evaluationRecordId: `${found.session.id}:${found.turn.turnId}`,
      variantId: found.turn.turnId,
      normallyCompleted: metrics.normallyCompleted,
      ...(metrics.firstTokenLatencyMs === undefined ? {} : { firstTokenLatencyMs: metrics.firstTokenLatencyMs }),
      totalDurationMs: metrics.totalDurationMs,
      toolUseWasExpected: metrics.toolCallCount > 0,
      toolSuccessCount: metrics.toolSuccessCount,
      toolFailureCount: metrics.toolFailureCount,
      errorCount: metrics.errorCount,
      permissionViolationCount: metrics.permissionViolationCount,
      hasRepeatedToolCall: metrics.hasRepeatedToolCall,
      modelRoundCount: metrics.modelRoundCount,
      toolCallCount: metrics.toolCallCount,
      totalContextTokens: metrics.totalContextTokens,
      totalOutputTokens: metrics.totalOutputTokens,
    }])[0];
    if (!execution) throw new ApiProblemError(409, "SCORECARD_INCOMPLETE", "执行能力评分尚未生成", true);
    return evaluation.putEffectScore(
      found.session.id,
      found.turn.turnId,
      draft,
      execution.score,
      await turnScoreInput(found, principal.principalId, agents),
    );
  });
}

/** 启动时为旧单轮评分补齐原子关联；旧 Turn 无冻结快照时明确跳过，绝不猜测配置。 */
export async function reconcileTurnEffectScoreResults(
  sessions: SessionRepository,
  evaluation: EvaluationModule,
  agents: AgentService,
): Promise<void> {
  for (const record of await evaluation.effectScoresForReconciliation()) {
    try {
      const found = await sessions.findTurn(record.turnId);
      if (!found || found.session.id !== record.sessionId || found.session.purpose !== "chat") continue;
      await evaluation.reconcileEffectScore(record, await turnScoreInput(found, found.session.ownerId, agents));
    } catch (error) {
      console.warn(`单轮评分 ${record.sessionId}/${record.turnId} 原子迁移已跳过：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** 将账号归属、聊天用途和完成状态收敛为两个路由共享的前置条件。 */
async function requireCompletedTurn(sessions: SessionRepository, turnId: string, ownerId: string) {
  const found = await sessions.findTurn(turnId, ownerId);
  if (!found) throw new ApiProblemError(404, "NOT_FOUND", "Turn 不存在", false);
  if (found.session.purpose !== "chat") throw new ApiProblemError(404, "NOT_FOUND", "Turn 不存在", false);
  if (found.turn.state.status !== "completed") {
    throw new ApiProblemError(409, "CONFLICT", "只有已完成的 Turn 可以进行效果打分", false);
  }
  return found;
}

/** 只使用 Turn 冻结事实构造排行配置，Agent 当前记录仅提供显示名称。 */
async function turnScoreInput(
  found: NonNullable<Awaited<ReturnType<SessionRepository["findTurn"]>>>,
  ownerId: string,
  agents: AgentService,
): Promise<Omit<ScoreResultUpsertInput, "dimensionScores" | "completed" | "recordedAt">> {
  const snapshot = found.turn.agentSnapshot;
  const reasoning = found.turn.resolvedReasoning;
  const agentSnapshotHash = found.turn.agentSnapshotHash;
  const agentId = found.turn.agentId ?? found.session.agentId;
  if (!snapshot || !reasoning || !agentSnapshotHash || !agentId) {
    throw new ApiProblemError(409, "TURN_SNAPSHOT_UNAVAILABLE", "本轮缺少冻结 Agent 配置，不能生成可聚合评分", false);
  }
  const agent = await agents.get(agentId, ownerId).catch(() => undefined);
  return {
    ownerId,
    modelStudentId: found.turn.modelStudentId ?? found.session.modelStudentId,
    source: { kind: "turn_effect", sessionId: found.session.id, turnId: found.turn.turnId },
    sourceTitle: `${found.session.title} · 单轮效果打分`,
    agentConfiguration: {
      agentSnapshotHash,
      agentId,
      agentName: agent?.name ?? `已删除 Agent · ${agentId.slice(0, 8)}`,
      systemPrompt: snapshot.systemPrompt,
      builtinTools: structuredClone(snapshot.builtinTools),
      builtinSkills: structuredClone(snapshot.builtinSkills),
      skills: structuredClone(snapshot.skills),
      mcps: structuredClone(snapshot.mcps),
      historyPolicy: structuredClone(snapshot.historyPolicy),
      memoryPolicy: structuredClone(snapshot.memoryPolicy),
      reasoning: structuredClone(reasoning),
    },
  };
}
