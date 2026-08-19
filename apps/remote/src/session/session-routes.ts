import { ApiProblemError } from "../server/api-problem.js";
import type { ControlRouter } from "../server/control-router.js";
import type { SessionRepository } from "../repository/session-repository.js";
import type { SessionLaunchService } from "./session-launch-service.js";

export function registerSessionRoutes(router: ControlRouter, sessions: SessionRepository, launches?: SessionLaunchService): void {
  if (launches) {
    router.register("POST", "/session-launches", async ({ json, principal }) => launches.create(await json(), principal.principalId));
    router.register("GET", "/session-launches/:launchId", ({ params, principal }) => launches.get(params.launchId ?? "", principal.principalId));
  }
  router.register("GET", "/sessions", async ({ url, principal }) => {
    const purpose = url.searchParams.get("purpose") === "experiment" ? "experiment" : "chat";
    const query = url.searchParams.get("query")?.trim().toLocaleLowerCase() ?? "";
    const items = (await sessions.all(purpose)).filter((item) => item.ownerId === principal.principalId)
      .filter((item) => !query || item.title.toLocaleLowerCase().includes(query))
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(sessionSummary);
    return { items };
  });
  router.register("GET", "/sessions/:sessionId", async ({ params, principal }) => {
    const session = await sessions.getPublic(params.sessionId ?? "");
    if (session.ownerId !== principal.principalId) throw new ApiProblemError(404, "NOT_FOUND", "Session 不存在", false);
    return sessionSummary(session);
  });
  router.register("GET", "/turns/:turnId", async ({ params, principal }) => {
    return turnView(await findTurn(sessions, params.turnId ?? "", principal.principalId));
  });
  router.register("GET", "/turns/:turnId/context", async ({ params, principal }) => {
    const found = await findTurn(sessions, params.turnId ?? "", principal.principalId);
    const prompt = found.session.sessionEntries.find((entry) => entry.type === "message" && entry.role === "user" && entry.turnId === found.turn.turnId);
    const answers = found.session.sessionEntries.flatMap((entry) => entry.type === "message" && entry.role === "assistant" && entry.turnId === found.turn.turnId ? [entry.text] : []);
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
        skillInstallationIds: found.turn.agentSnapshot.skills.filter((item) => item.enabled).map((item) => item.skillInstallationId),
        mcps: found.turn.agentSnapshot.mcps,
        historyPolicy: found.turn.agentSnapshot.historyPolicy,
        memoryPolicy: found.turn.agentSnapshot.memoryPolicy,
      },
      ...(found.turn.resolvedReasoning ? { resolvedReasoning: found.turn.resolvedReasoning } : {}),
      agentSnapshotHash: found.turn.agentSnapshotHash,
      capabilitySnapshots: found.turn.capabilitySnapshots ?? [],
      modelRounds: found.turn.modelRounds,
    };
  });
}

async function findTurn(sessions: SessionRepository, turnId: string, ownerId: string) {
  for (const session of await sessions.all()) {
    if (session.ownerId !== ownerId) continue;
    const turn = session.turns.find((item) => item.turnId === turnId);
    if (turn) return { session, turn };
  }
  throw new ApiProblemError(404, "NOT_FOUND", "Turn 不存在", false);
}

function turnView(found: Awaited<ReturnType<typeof findTurn>>) {
  return {
    ...found.turn,
    sessionId: found.session.id,
    purpose: found.session.purpose,
    modelStudentId: found.turn.modelStudentId ?? found.session.modelStudentId,
    agentId: found.turn.agentId ?? found.session.agentId,
  };
}

function sessionSummary(session: import("../repository/session-types.js").SessionRecord) {
  const lastUser = session.sessionEntries.findLast((entry) => entry.type === "message" && entry.role === "user");
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
    preview: lastUser?.type === "message" ? lastUser.text.slice(0, 160) : "",
    turnCount: session.turns.length,
    updatedAt: session.updatedAt,
    createdAt: session.createdAt,
  };
}
