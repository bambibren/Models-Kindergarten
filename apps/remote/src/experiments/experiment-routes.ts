import { ApiProblemError } from "../server/api-problem.js";
import type { ControlRouter } from "../server/control-router.js";
import type { ExperimentService } from "./experiment-service.js";
import type { ContextPreviewService } from "./context-preview-service.js";

/** 执行「registerExperimentRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function registerExperimentRoutes(router: ControlRouter, service: ExperimentService, previews?: ContextPreviewService): void {
  if (previews) router.register("POST", "/context-previews", /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
async ({ json, principal }) => previews.preview(await json(), principal.principalId));
  router.register("POST", "/experiments", /** 执行「registerExperimentRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async ({ json, principal }) => service.create(await json(), principal.principalId));
  router.register("PUT", "/experiments/:experimentId", /** 执行「registerExperimentRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async ({ params, json, principal }) =>
    service.update(params.experimentId ?? "", await json(), principal.principalId));
  router.register("POST", "/experiments/:experimentId/prepare-run", /** 执行「registerExperimentRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
({ params, request, principal }) =>
    service.prepareRun(params.experimentId ?? "", request.headers.get("idempotency-key") ?? "", principal.principalId));
  router.register("POST", "/experiments/:experimentId/cancel", /** 执行「registerExperimentRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
({ params, principal }) =>
    service.cancel(params.experimentId ?? "", principal.principalId));
  router.register("POST", "/experiments/:experimentId/tests/:testId/interventions", /** 执行「registerExperimentRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async ({ params, json, principal }) =>
    service.recordIntervention(params.experimentId ?? "", params.testId ?? "", await json(), principal.principalId));
  router.register("GET", "/experiments", /** 执行「registerExperimentRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
({ url, principal }) => service.list(principal.principalId, url.searchParams.get("saved") === "true"));
  router.register("GET", "/experiments/:experimentId", /** 执行「registerExperimentRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
({ params, principal }) => service.get(params.experimentId ?? "", principal.principalId));
  router.register("DELETE", "/experiments/:experimentId", /** 执行「registerExperimentRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
({ params, principal }) => service.delete(params.experimentId ?? "", principal.principalId));
  router.register("POST", "/experiments/:experimentId/save", /** 执行「registerExperimentRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
({ params, principal }) => service.save(params.experimentId ?? "", principal.principalId));
  router.register("POST", "/experiments/:experimentId/annotation-worksheet", /** 执行「registerExperimentRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async ({ params, json, principal }) => {
    const body = await json().catch(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => ({})) as { force?: unknown; worksheetModelStudentId?: unknown };
    return service.generateAnnotationWorksheet(
      params.experimentId ?? "",
      body.force === true,
      principal.principalId,
      typeof body.worksheetModelStudentId === "string" ? body.worksheetModelStudentId : undefined,
    );
  });
  router.register("POST", "/experiments/:experimentId/variants/:variantId/client-failure", /** 执行「registerExperimentRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
({ params, principal }) =>
    service.markRunClientFailure(params.experimentId ?? "", params.variantId ?? "", principal.principalId));
  router.register("PUT", "/experiments/:experimentId/annotations", /** 执行「registerExperimentRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async ({ params, json, principal }) =>
    service.putAnnotations(params.experimentId ?? "", await json(), principal.principalId));
  router.register("GET", "/experiments/:experimentId/scorecard", /** 执行「registerExperimentRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async ({ params, principal }) => {
    const value = await service.scorecard(params.experimentId ?? "", principal.principalId);
    if (!value) throw new ApiProblemError(404, "NOT_FOUND", "Experiment Scorecard 不存在", false);
    return value;
  });
}
