import type { ControlRouter } from "../server/control-router.js";
import type { AgentInput } from "@kindergarten/contracts";
import type { AgentService } from "./agent-service.js";

interface AgentRouteOptions {
  defaultAgentInput?: (ownerId: string) => AgentInput | Promise<AgentInput>;
}

/** 执行「registerAgentRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function registerAgentRoutes(
  router: ControlRouter,
  service: AgentService,
  options: AgentRouteOptions = {},
): void {
  router.register("GET", "/agents", /** 执行「registerAgentRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
  async ({ url, principal }) => {
    await service.reconcileCapabilities(principal.principalId);
    if (options.defaultAgentInput) {
      await service.ensureDefault(await options.defaultAgentInput(principal.principalId), principal.principalId);
    }
    const query = url.searchParams.get("query");
    const cursor = url.searchParams.get("cursor");
    const limit = parseLimit(url.searchParams.get("limit"));
    return service.list({
      ...(query === null ? {} : { query }),
      ...(cursor === null ? {} : { cursor }),
      ...(limit === undefined ? {} : { limit }),
    }, principal.principalId);
  });
  router.register("POST", "/agents", /** 执行「registerAgentRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async ({ json, principal }) => service.create(await json(), principal.principalId));
  router.register("GET", "/agents/:agentId", /** 执行「registerAgentRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async ({ params, principal }) => {
    await service.reconcileCapabilities(principal.principalId);
    return service.get(params.agentId ?? "", principal.principalId);
  });
  router.register("PUT", "/agents/:agentId", /** 执行「registerAgentRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async ({ params, json, principal }) => service.update(params.agentId ?? "", await json(), principal.principalId));
  router.register("DELETE", "/agents/:agentId", /** 执行「registerAgentRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
({ params, principal }) => service.delete(params.agentId ?? "", principal.principalId));
  router.register("GET", "/capability-options", /** 执行「registerAgentRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
({ principal }) => service.capabilityOptions(principal.principalId));
}

/** 校验并规范化「parseLimit」输入，非法数据直接返回明确错误。 */
function parseLimit(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}
