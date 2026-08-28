import { ApiProblemError } from "../server/api-problem.js";
import type { ControlRouter } from "../server/control-router.js";
import type { SkillInstallationService } from "./skill-installation-service.js";

/** 执行「registerSkillRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function registerSkillRoutes(router: ControlRouter, service: SkillInstallationService): void {
  router.register("GET", "/skills", /** 执行「registerSkillRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async ({ url, principal }) => {
    const state = url.searchParams.get("state");
    const query = url.searchParams.get("query")?.trim().toLocaleLowerCase() ?? "";
    const items = (await service.list(principal.principalId)).filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) =>
      (!state || item.state === state) && (!query || `${item.displayName ?? ""}\n${sourceLabel(item.source)}`.toLocaleLowerCase().includes(query)));
    return { items };
  });
  router.register("GET", "/skills/:skillInstallationId", /** 执行「registerSkillRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
({ params, principal }) =>
    service.get(params.skillInstallationId ?? "", principal.principalId));
  router.register("DELETE", "/skills/:skillInstallationId", /** 执行「registerSkillRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
({ params, principal }) =>
    service.uninstall(params.skillInstallationId ?? "", principal.principalId));
  router.register("POST", "/skill-install-jobs", /** 执行「registerSkillRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async ({ json, principal }) => {
    const body = await json();
    if (!record(body) || !Array.isArray(body.sourceUrls) || !body.sourceUrls.every(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => typeof item === "string")) {
      throw new ApiProblemError(400, "VALIDATION_FAILED", "sourceUrls 必须是字符串数组", false);
    }
    return service.createManualJob(body.sourceUrls, {
      bindToAgentOnComplete: body.bindToAgentOnComplete === true,
      ...(typeof body.agentId === "string" ? { agentId: body.agentId } : {}),
    }, principal.principalId);
  });
  router.register("GET", "/skill-install-jobs/:jobId", /** 执行「registerSkillRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
({ params, principal }) =>
    service.getJob(params.jobId ?? "", principal.principalId));
  router.register("POST", "/skill-install-jobs/:jobId/retry", /** 执行「registerSkillRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
({ params, principal }) =>
    service.retryJob(params.jobId ?? "", principal.principalId));
}

/** 执行「sourceLabel」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function sourceLabel(source: import("@kindergarten/contracts").SkillSource): string {
  if (source.kind === "github_tree") return `${source.repository}/${source.subdirectory}`;
  return source.kind === "resource_bundle" ? source.url : source.sourceId;
}

/** 更新「record」对应状态，并保持写入顺序、原子性与容量约束。 */
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
