import { ApiProblemError } from "../server/api-problem.js";
import type { ControlRouter } from "../server/control-router.js";
import type { SkillInstallationService } from "./skill-installation-service.js";

export function registerSkillRoutes(router: ControlRouter, service: SkillInstallationService): void {
  router.register("GET", "/skills", async ({ url, principal }) => {
    const state = url.searchParams.get("state");
    const query = url.searchParams.get("query")?.trim().toLocaleLowerCase() ?? "";
    const items = (await service.list(principal.principalId)).filter((item) =>
      (!state || item.state === state) && (!query || `${item.displayName ?? ""}\n${sourceLabel(item.source)}`.toLocaleLowerCase().includes(query)));
    return { items };
  });
  router.register("GET", "/skills/:skillInstallationId", ({ params, principal }) =>
    service.get(params.skillInstallationId ?? "", principal.principalId));
  router.register("DELETE", "/skills/:skillInstallationId", ({ params, principal }) =>
    service.uninstall(params.skillInstallationId ?? "", principal.principalId));
  router.register("POST", "/skill-install-jobs", async ({ json, principal }) => {
    const body = await json();
    if (!record(body) || !Array.isArray(body.sourceUrls) || !body.sourceUrls.every((item) => typeof item === "string")) {
      throw new ApiProblemError(400, "VALIDATION_FAILED", "sourceUrls 必须是字符串数组", false);
    }
    return service.createManualJob(body.sourceUrls, {
      bindToAgentOnComplete: body.bindToAgentOnComplete === true,
      ...(typeof body.agentId === "string" ? { agentId: body.agentId } : {}),
    }, principal.principalId);
  });
  router.register("GET", "/skill-install-jobs/:jobId", ({ params, principal }) =>
    service.getJob(params.jobId ?? "", principal.principalId));
  router.register("POST", "/skill-install-jobs/:jobId/retry", ({ params, principal }) =>
    service.retryJob(params.jobId ?? "", principal.principalId));
}

function sourceLabel(source: import("@kindergarten/contracts").SkillSource): string {
  return source.kind === "github_tree" ? `${source.repository}/${source.subdirectory}` : source.sourceId;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
