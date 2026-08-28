import type { ControlRouter } from "../server/control-router.js";
import type { ModelAdmissionService } from "./model-admission-service.js";

/** 执行「registerModelAdmissionRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function registerModelAdmissionRoutes(
  router: ControlRouter,
  service: ModelAdmissionService,
): void {
  router.register("GET", "/model-provider-presets", /** 执行「registerModelAdmissionRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => ({
    items: service.providerPresets(),
  }));
  router.register("POST", "/model-student-tests", /** 执行「registerModelAdmissionRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async ({ json, principal }) =>
    service.test(await json(), principal.principalId));
  router.register("GET", "/model-student-tests/:testId", /** 执行「registerModelAdmissionRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
({ params, principal }) =>
    service.getTest(params.testId ?? "", principal.principalId));
  router.register("GET", "/model-students", /** 执行「registerModelAdmissionRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async ({ principal }) => ({
    items: await service.list(principal.principalId),
  }));
  router.register("POST", "/model-students", /** 执行「registerModelAdmissionRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async ({ json, principal }) =>
    service.install(await json(), principal.principalId));
  router.register("GET", "/model-students/:modelStudentId", /** 执行「registerModelAdmissionRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
({ params, principal }) =>
    service.get(params.modelStudentId ?? "", principal.principalId));
  router.register("DELETE", "/model-students/:modelStudentId", /** 执行「registerModelAdmissionRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
({ params, principal }) =>
    service.remove(params.modelStudentId ?? "", principal.principalId));
}
