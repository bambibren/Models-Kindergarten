import type { ControlRouter } from "../server/control-router.js";
import type { McpManagementService } from "./mcp-management-service.js";

/** 执行「registerMcpRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function registerMcpRoutes(router: ControlRouter, service: McpManagementService): void {
  router.register("POST", "/mcp-tests", /** 执行「registerMcpRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async ({ json, principal }) => service.test(await json(), principal.principalId));
  router.register("GET", "/mcp-tests/:testId", /** 执行「registerMcpRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
({ params, principal }) => service.getTest(params.testId ?? "", principal.principalId));
  router.register("GET", "/mcps", /** 执行「registerMcpRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
({ principal }) => service.list(principal.principalId));
  router.register("POST", "/mcps", /** 执行「registerMcpRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async ({ json, principal }) => service.install(await json(), principal.principalId));
  router.register("GET", "/mcps/:mcpId", /** 执行「registerMcpRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
({ params, principal }) => service.get(params.mcpId ?? "", principal.principalId));
  router.register("POST", "/mcps/:mcpId/reconnect", /** 执行「registerMcpRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
({ params, principal }) => service.reconnect(params.mcpId ?? "", principal.principalId));
  router.register("POST", "/mcps/:mcpId/refresh-capabilities", /** 执行「registerMcpRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
({ params, principal }) => service.reconnect(params.mcpId ?? "", principal.principalId));
  router.register("POST", "/mcps/:mcpId/disable", /** 执行「registerMcpRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
({ params, principal }) => service.setEnabled(params.mcpId ?? "", false, principal.principalId));
  router.register("POST", "/mcps/:mcpId/enable", /** 执行「registerMcpRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
({ params, principal }) => service.setEnabled(params.mcpId ?? "", true, principal.principalId));
  router.register("DELETE", "/mcps/:mcpId", /** 执行「registerMcpRoutes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
({ params, principal }) => service.uninstall(params.mcpId ?? "", principal.principalId));
}
