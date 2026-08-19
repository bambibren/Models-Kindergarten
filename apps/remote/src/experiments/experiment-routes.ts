import { ApiProblemError } from "../server/api-problem.js";
import type { ControlRouter } from "../server/control-router.js";
import type { ExperimentService } from "./experiment-service.js";
import type { ContextPreviewService } from "./context-preview-service.js";

export function registerExperimentRoutes(router: ControlRouter, service: ExperimentService, previews?: ContextPreviewService): void {
  if (previews) router.register("POST", "/context-previews", async ({ json, principal }) => previews.preview(await json(), principal.principalId));
  router.register("POST", "/experiments", async ({ json, principal }) => service.create(await json(), principal.principalId));
  router.register("PUT", "/experiments/:experimentId", async ({ params, json, principal }) =>
    service.update(params.experimentId ?? "", await json(), principal.principalId));
  router.register("POST", "/experiments/:experimentId/prepare-run", ({ params, request, principal }) =>
    service.prepareRun(params.experimentId ?? "", request.headers.get("idempotency-key") ?? "", principal.principalId));
  router.register("POST", "/experiments/:experimentId/cancel", ({ params, principal }) =>
    service.cancel(params.experimentId ?? "", principal.principalId));
  router.register("POST", "/experiments/:experimentId/tests/:testId/interventions", async ({ params, json, principal }) =>
    service.recordIntervention(params.experimentId ?? "", params.testId ?? "", await json(), principal.principalId));
  router.register("GET", "/experiments", ({ url, principal }) => service.list(principal.principalId, url.searchParams.get("saved") === "true"));
  router.register("GET", "/experiments/:experimentId", ({ params, principal }) => service.get(params.experimentId ?? "", principal.principalId));
  router.register("DELETE", "/experiments/:experimentId", ({ params, principal }) => service.delete(params.experimentId ?? "", principal.principalId));
  router.register("POST", "/experiments/:experimentId/save", ({ params, principal }) => service.save(params.experimentId ?? "", principal.principalId));
  router.register("POST", "/experiments/:experimentId/annotation-worksheet", async ({ params, json, principal }) => {
    const body = await json().catch(() => ({})) as { force?: unknown; worksheetModelStudentId?: unknown };
    return service.generateAnnotationWorksheet(
      params.experimentId ?? "",
      body.force === true,
      principal.principalId,
      typeof body.worksheetModelStudentId === "string" ? body.worksheetModelStudentId : undefined,
    );
  });
  router.register("POST", "/experiments/:experimentId/variants/:variantId/client-failure", ({ params, principal }) =>
    service.markRunClientFailure(params.experimentId ?? "", params.variantId ?? "", principal.principalId));
  router.register("PUT", "/experiments/:experimentId/annotations", async ({ params, json, principal }) =>
    service.putAnnotations(params.experimentId ?? "", await json(), principal.principalId));
  router.register("GET", "/experiments/:experimentId/scorecard", async ({ params, principal }) => {
    const value = await service.scorecard(params.experimentId ?? "", principal.principalId);
    if (!value) throw new ApiProblemError(404, "NOT_FOUND", "Experiment Scorecard 不存在", false);
    return value;
  });
}
