import { describe, expect, it } from "vitest";
import type { EvaluationModule } from "../../src/evaluation/evaluation-module.js";
import { registerScoreResultRoutes } from "../../src/evaluation/score-result-routes.js";
import type { ModelAdmissionService } from "../../src/model/model-admission-service.js";
import { ControlApi } from "../../src/server/control-api.js";

describe("score result routes", () => {
  it("模型聚合和原子评分查询都使用登录账号收紧范围", async () => {
    const calls: Array<[string, string]> = [];
    const evaluation = {
      modelScoreGroups: async (ownerId: string, modelStudentId: string) => {
        calls.push([ownerId, modelStudentId]);
        return [{ configurationHash: "config-1", agentName: "研究助手", sampleCount: 2, averageScore: 88, minScore: 80, maxScore: 96, lastScoredAt: "now" }];
      },
      getScoreResult: async (id: string, ownerId: string) => ownerId === "local-admin" && id === "score-1" ? { scoreResultId: id, ownerId } : undefined,
    } as unknown as EvaluationModule;
    const models = { get: async (id: string, ownerId: string) => {
      calls.push([ownerId, id]);
      return { modelStudentId: id };
    } } as unknown as ModelAdmissionService;
    const api = new ControlApi({ allowedOrigins: ["http://127.0.0.1:5173"] });
    registerScoreResultRoutes(api.router, evaluation, models);

    const groups = await api.fetch(new Request("http://remote/api/control/v1/model-students/model-1/score-groups"));
    expect(groups?.status).toBe(200);
    expect(await groups?.json()).toMatchObject({ data: { items: [{ averageScore: 88, minScore: 80, maxScore: 96 }] } });
    expect(calls).toEqual([["local-admin", "model-1"], ["local-admin", "model-1"]]);

    const atom = await api.fetch(new Request("http://remote/api/control/v1/score-results/score-1"));
    expect(atom?.status).toBe(200);
    expect(await atom?.json()).toMatchObject({ data: { scoreResultId: "score-1", ownerId: "local-admin" } });
    expect((await api.fetch(new Request("http://remote/api/control/v1/score-results/missing")))?.status).toBe(404);
  });
});
