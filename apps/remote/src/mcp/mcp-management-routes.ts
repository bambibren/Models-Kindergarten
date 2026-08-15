import type { ControlRouter } from "../server/control-router.js";
import type { McpManagementService } from "./mcp-management-service.js";

export function registerMcpRoutes(router: ControlRouter, service: McpManagementService): void {
  router.register("POST", "/mcp-tests", async ({ json, principal }) => service.test(await json(), principal.principalId));
  router.register("GET", "/mcp-tests/:testId", ({ params, principal }) => service.getTest(params.testId ?? "", principal.principalId));
  router.register("GET", "/mcps", ({ principal }) => service.list(principal.principalId));
  router.register("POST", "/mcps", async ({ json, principal }) => service.install(await json(), principal.principalId));
  router.register("GET", "/mcps/:mcpId", ({ params, principal }) => service.get(params.mcpId ?? "", principal.principalId));
  router.register("POST", "/mcps/:mcpId/reconnect", ({ params, principal }) => service.reconnect(params.mcpId ?? "", principal.principalId));
  router.register("POST", "/mcps/:mcpId/refresh-capabilities", ({ params, principal }) => service.reconnect(params.mcpId ?? "", principal.principalId));
  router.register("POST", "/mcps/:mcpId/disable", ({ params, principal }) => service.setEnabled(params.mcpId ?? "", false, principal.principalId));
  router.register("POST", "/mcps/:mcpId/enable", ({ params, principal }) => service.setEnabled(params.mcpId ?? "", true, principal.principalId));
  router.register("DELETE", "/mcps/:mcpId", ({ params, principal }) => service.uninstall(params.mcpId ?? "", principal.principalId));
}
