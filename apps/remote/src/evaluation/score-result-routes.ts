import type { ModelAdmissionService } from "../model/model-admission-service.js";
import { ApiProblemError } from "../server/api-problem.js";
import type { ControlRouter } from "../server/control-router.js";
import type { EvaluationModule } from "./evaluation-module.js";

/** 原子评分和模型聚合只通过已认证 Control API 暴露，不让客户端按文件结构查询。 */
export function registerScoreResultRoutes(
  router: ControlRouter,
  evaluation: EvaluationModule,
  models: ModelAdmissionService,
): void {
  router.register("GET", "/score-results/:scoreResultId", async ({ params, principal }) => {
    const record = await evaluation.getScoreResult(params.scoreResultId ?? "", principal.principalId);
    if (!record) throw new ApiProblemError(404, "NOT_FOUND", "评分记录不存在", false);
    return record;
  });

  router.register("GET", "/model-students/:modelStudentId/score-groups", async ({ params, principal }) => {
    const modelStudentId = params.modelStudentId ?? "";
    await models.get(modelStudentId, principal.principalId);
    return { items: await evaluation.modelScoreGroups(principal.principalId, modelStudentId) };
  });

  router.register("GET", "/model-students/:modelStudentId/score-groups/:configurationHash", async ({ params, principal }) => {
    const modelStudentId = params.modelStudentId ?? "";
    await models.get(modelStudentId, principal.principalId);
    const detail = await evaluation.modelScoreGroup(
      principal.principalId,
      modelStudentId,
      params.configurationHash ?? "",
    );
    if (!detail) throw new ApiProblemError(404, "NOT_FOUND", "Agent 配置评分不存在", false);
    return detail;
  });
}
