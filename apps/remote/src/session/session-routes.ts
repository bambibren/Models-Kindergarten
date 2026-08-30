import { PRODUCT_CONFIG } from "@kindergarten/contracts";
import { ApiProblemError } from "../server/api-problem.js";
import type { ControlRouter } from "../server/control-router.js";
import type { SessionRepository } from "../repository/session-repository.js";
import type { SessionLaunchService } from "./session-launch-service.js";

/** 执行「registerSessionRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function registerSessionRoutes(router: ControlRouter, sessions: SessionRepository, launches?: SessionLaunchService): void {
  if (launches) {
    router.register("POST", "/session-launches", /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
async ({ json, principal }) => launches.create(await json(), principal.principalId));
    router.register("GET", "/session-launches/:launchId", /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
({ params, principal }) => launches.get(params.launchId ?? "", principal.principalId));
  }
  router.register("GET", "/sessions", /** 执行「registerSessionRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async ({ url, principal }) => {
    const purpose = url.searchParams.get("purpose") === "experiment" ? "experiment" : "chat";
    const query = url.searchParams.get("query")?.trim().toLocaleLowerCase() ?? "";
    const items = (await sessions.listMetadata(purpose)).filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.ownerId === principal.principalId)
      .filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => !query || item.title.toLocaleLowerCase().includes(query))
      .toSorted(/** 执行「map」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(sessionSummary);
    return { items };
  });
  router.register("GET", "/sessions/:sessionId", /** 执行「registerSessionRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async ({ params, principal }) => {
    const session = await sessions.getMetadata(params.sessionId ?? "");
    if (session.ownerId !== principal.principalId) throw new ApiProblemError(404, "NOT_FOUND", "Session 不存在", false);
    return sessionSummary(session);
  });
  router.register("GET", "/sessions/:sessionId/turns", /** 执行「registerSessionRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async ({ params, url, principal }) => {
    const sessionId = params.sessionId ?? "";
    const summary = await sessions.getRecent(sessionId, 0);
    if (summary.ownerId !== principal.principalId) throw new ApiProblemError(404, "NOT_FOUND", "Session 不存在", false);
    const requested = Number(url.searchParams.get("limit") ?? String(PRODUCT_CONFIG.agent.historyPageTurns));
    const limit = Number.isInteger(requested)
      ? Math.max(1, Math.min(PRODUCT_CONFIG.agent.historyPageTurns, requested))
      : PRODUCT_CONFIG.agent.historyPageTurns;
    const page = await sessions.turnPage(sessionId, limit, url.searchParams.get("beforeTurnId") ?? undefined);
    return {
      schemaVersion: 1,
      session: sessionSummary(page.session),
      turns: page.session.turns.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(turn) => ({
        turnId: turn.turnId,
        state: turn.state,
        startedAt: turn.startedAt,
        ...(turn.completedAt ? { completedAt: turn.completedAt } : {}),
        // Provider continuation 与不可变 Agent 快照不属于聊天历史分页响应。
        entries: page.session.sessionEntries.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(entry) =>
          entry.turnId === turn.turnId && entry.type !== "provider_continuation"),
      })),
      hasMore: page.hasMore,
      ...(page.nextBeforeTurnId ? { nextBeforeTurnId: page.nextBeforeTurnId } : {}),
    };
  });
  router.register("GET", "/turns/:turnId", /** 执行「registerSessionRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async ({ params, principal }) => {
    return turnView(await findTurn(sessions, params.turnId ?? "", principal.principalId));
  });
  router.register("GET", "/turns/:turnId/context", /** 执行「registerSessionRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async ({ params, principal }) => {
    const found = await findTurn(sessions, params.turnId ?? "", principal.principalId);
    const prompt = found.session.sessionEntries.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(entry) => entry.type === "message" && entry.role === "user" && entry.turnId === found.turn.turnId);
    const answers = found.session.sessionEntries.flatMap(/** 执行「answers」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(entry) => entry.type === "message" && entry.role === "assistant" && entry.turnId === found.turn.turnId ? [entry.text] : []);
    if (!found.turn.modelRounds?.[0] || !found.turn.agentSnapshot || !found.turn.agentSnapshotHash) {
      throw new ApiProblemError(409, "TURN_SNAPSHOT_UNAVAILABLE", "该历史 Turn 创建时尚未保存不可变上下文快照", false);
    }
    return {
      schemaVersion: 1,
      turn: turnView(found),
      promptText: prompt?.type === "message" ? prompt.text : "",
      answerTexts: answers,
      sourcePolicy: {
        systemPrompt: found.turn.agentSnapshot.systemPrompt,
        builtinTools: found.turn.agentSnapshot.builtinTools,
        builtinSkillIds: (found.turn.agentSnapshot.builtinSkills ?? [])
          .filter((item) => item.enabled)
          .map((item) => item.skillId),
        skillInstallationIds: found.turn.agentSnapshot.skills.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.enabled).map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.skillInstallationId),
        mcps: found.turn.agentSnapshot.mcps,
        historyPolicy: found.turn.agentSnapshot.historyPolicy,
        memoryPolicy: found.turn.agentSnapshot.memoryPolicy,
      },
      ...(found.turn.resolvedReasoning ? { resolvedReasoning: found.turn.resolvedReasoning } : {}),
      agentSnapshotHash: found.turn.agentSnapshotHash,
      capabilitySnapshots: found.turn.capabilitySnapshots ?? [],
      modelRounds: await Promise.all(found.turn.modelRounds.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
async (round) => ({
        ...round,
        ...(round.providerInputRef
          ? { providerInput: await sessions.readProviderInput(found.session.id, found.turn.turnId, round.roundIndex) }
          : round.providerInput ? { providerInput: round.providerInput } : {}),
      }))),
    };
  });
}

/** 读取「findTurn」所需数据，并遵守作用域、分页与容量边界。 */
async function findTurn(sessions: SessionRepository, turnId: string, ownerId: string) {
  const found = await sessions.findTurn(turnId, ownerId);
  if (found) return found;
  throw new ApiProblemError(404, "NOT_FOUND", "Turn 不存在", false);
}

/** 执行「turnView」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function turnView(found: Awaited<ReturnType<typeof findTurn>>) {
  return {
    ...found.turn,
    sessionId: found.session.id,
    purpose: found.session.purpose,
    modelStudentId: found.turn.modelStudentId ?? found.session.modelStudentId,
    agentId: found.turn.agentId ?? found.session.agentId,
  };
}

/** 执行「sessionSummary」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function sessionSummary(session: import("../repository/session-types.js").SessionRecord & {
  indexedTurnCount?: number;
  indexedPreview?: string;
}) {
  const lastUser = session.sessionEntries.findLast(/** 执行「lastUser」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(entry) => entry.type === "message" && entry.role === "user");
  return {
    schemaVersion: 1,
    sessionId: session.id,
    purpose: session.purpose,
    cwd: session.cwd,
    title: session.title,
    modelStudentId: session.modelStudentId,
    agentId: session.agentId,
    ...(session.reasoningOverride ? { reasoningOverride: session.reasoningOverride } : {}),
    ...(session.experimentRef ? { experimentRef: session.experimentRef } : {}),
    preview: session.indexedPreview ?? (lastUser?.type === "message" ? lastUser.text.slice(0, 160) : ""),
    turnCount: session.indexedTurnCount ?? session.turns.length,
    updatedAt: session.updatedAt,
    createdAt: session.createdAt,
  };
}
