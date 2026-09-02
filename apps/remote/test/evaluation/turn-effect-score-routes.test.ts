import { describe, expect, it } from "vitest";
import type { TurnEvaluationRecord } from "@kindergarten/evaluation-contract";
import type { SessionRepository } from "../../src/repository/session-repository.js";
import { ControlApi } from "../../src/server/control-api.js";
import { registerTurnEffectScoreRoutes } from "../../src/evaluation/turn-effect-score-routes.js";
import type { EvaluationModule } from "../../src/evaluation/evaluation-module.js";
import type { AgentService } from "../../src/agent/agent-service.js";

describe("Turn effect score routes", () => {
  it("只通过完成态且属于当前账号的 Turn 保存人工打分", async () => {
    let written: unknown;
    const sessions = {
      findTurn: async (turnId: string, ownerId: string) => ownerId === "local-admin" && turnId === "turn-1" ? {
        session: { id: "session-1", purpose: "chat", title: "测试对话", modelStudentId: "model-1", agentId: "agent-1" },
        turn: {
          turnId,
          state: { schemaVersion: 1, turnId, status: "completed" },
          modelStudentId: "model-1",
          agentId: "agent-1",
          agentSnapshotHash: "snapshot-1",
          agentSnapshot: {
            systemPrompt: "完成任务", builtinTools: [], builtinSkills: [], skills: [], mcps: [],
            historyPolicy: { mode: "none" }, memoryPolicy: { mode: "off" },
          },
          resolvedReasoning: {
            schemaVersion: 1, requestedProfile: "balanced", resolvedProfile: "balanced",
            source: "model_default", providerKind: "fixture", model: "fixture-model", native: {},
          },
        },
      } : undefined,
    } as unknown as SessionRepository;
    const evaluationRecord = {
      result: {
        normallyCompleted: true,
        modelRoundCount: 1,
        toolCallCount: 0,
        toolSuccessCount: 0,
        toolFailureCount: 0,
        hasRepeatedToolCall: false,
        totalContextTokens: 10,
        truncatedContextItemCount: 0,
        totalDurationMs: 100,
        totalOutputTokens: 20,
        errorCount: 0,
        permissionViolationCount: 0,
      },
    } as TurnEvaluationRecord;
    const evaluation = {
      getEffectScore: async () => undefined,
      get: async () => evaluationRecord,
      putEffectScore: async (sessionId: string, turnId: string, draft: unknown, executionScore: number, scoreInput: unknown) => {
        written = { sessionId, turnId, draft, executionScore, scoreInput };
        return { ...(draft as object), sessionId, turnId, executionScore, savedAt: "now" };
      },
    } as unknown as EvaluationModule;
    const agents = { get: async () => ({ name: "测试 Agent" }) } as unknown as AgentService;
    const api = new ControlApi({ allowedOrigins: ["http://127.0.0.1:5173"] });
    registerTurnEffectScoreRoutes(api.router, sessions, evaluation, agents);
    const response = await api.fetch(new Request("http://remote/api/control/v1/turns/turn-1/effect-score", {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({
        schemaVersion: 1,
        annotations: {
          understanding: { requirements: [], completed: false },
          planning: { score: 70, completed: true },
          output: { score: 80, marks: [], completed: true },
        },
      }),
    }));

    expect(response?.status).toBe(200);
    expect(written).toMatchObject({
      sessionId: "session-1", turnId: "turn-1", executionScore: 95,
      scoreInput: { modelStudentId: "model-1", agentConfiguration: { agentSnapshotHash: "snapshot-1", agentName: "测试 Agent" } },
    });
  });
});
