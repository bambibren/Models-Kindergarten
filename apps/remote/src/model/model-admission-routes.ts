import type { ControlRouter } from "../server/control-router.js";
import type { ModelAdmissionService } from "./model-admission-service.js";

export function registerModelAdmissionRoutes(
  router: ControlRouter,
  service: ModelAdmissionService,
): void {
  router.register("GET", "/model-provider-presets", () => ({
    items: service.providerPresets(),
  }));
  router.register("POST", "/model-student-tests", async ({ json, principal }) =>
    service.test(await json(), principal.principalId));
  router.register("GET", "/model-student-tests/:testId", ({ params, principal }) =>
    service.getTest(params.testId ?? "", principal.principalId));
  router.register("GET", "/model-students", async ({ principal }) => ({
    items: await service.list(principal.principalId),
  }));
  router.register("POST", "/model-students", async ({ json, principal }) =>
    service.install(await json(), principal.principalId));
  router.register("GET", "/model-students/:modelStudentId", ({ params, principal }) =>
    service.get(params.modelStudentId ?? "", principal.principalId));
  router.register("DELETE", "/model-students/:modelStudentId", ({ params, principal }) =>
    service.remove(params.modelStudentId ?? "", principal.principalId));
}
