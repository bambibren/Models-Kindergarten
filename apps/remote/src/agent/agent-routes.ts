import type { ControlRouter } from "../server/control-router.js";
import type { AgentService } from "./agent-service.js";

export function registerAgentRoutes(router: ControlRouter, service: AgentService): void {
  router.register("GET", "/agents", ({ url, principal }) => {
    const query = url.searchParams.get("query");
    const cursor = url.searchParams.get("cursor");
    const limit = parseLimit(url.searchParams.get("limit"));
    return service.list({
      ...(query === null ? {} : { query }),
      ...(cursor === null ? {} : { cursor }),
      ...(limit === undefined ? {} : { limit }),
    }, principal.principalId);
  });
  router.register("POST", "/agents", async ({ json, principal }) => service.create(await json(), principal.principalId));
  router.register("GET", "/agents/:agentId", ({ params, principal }) => service.get(params.agentId ?? "", principal.principalId));
  router.register("PUT", "/agents/:agentId", async ({ params, json, principal }) => service.update(params.agentId ?? "", await json(), principal.principalId));
  router.register("DELETE", "/agents/:agentId", ({ params, principal }) => service.delete(params.agentId ?? "", principal.principalId));
  router.register("GET", "/capability-options", () => service.capabilityOptions());
}

function parseLimit(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}
