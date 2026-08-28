import type { DemoAgentStrategy, DemoMcpInstallation, DemoStreamItem } from "../demo-types.js";

export const demoMcpStorageKey = "models-kindergarten.demo-mcps";
export const demoMcpRemovedStorageKey = "models-kindergarten.demo-mcps.removed";

/** 描述「McpDemoStorage」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface McpDemoStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 读取「loadSavedMcps」所需数据，并遵守作用域、分页与容量边界。 */
export function loadSavedMcps(storage: McpDemoStorage): DemoMcpInstallation[] {
  const raw = storage.getItem(demoMcpStorageKey);
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter(isMcpInstallation) : [];
  } catch {
    return [];
  }
}

/** 更新「saveMcp」对应状态，并保持写入顺序、原子性与容量约束。 */
export function saveMcp(storage: McpDemoStorage, installation: DemoMcpInstallation): DemoMcpInstallation[] {
  const current = loadSavedMcps(storage);
  const next = [installation, ...current.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(candidate) => candidate.id !== installation.id)];
  storage.setItem(demoMcpStorageKey, JSON.stringify(next));
  const removed = loadRemovedMcpIds(storage).filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(id) => id !== installation.id);
  storage.setItem(demoMcpRemovedStorageKey, JSON.stringify(removed));
  return next;
}

/** 释放或删除「removeMcp」对应资源，重复调用仍保持安全。 */
export function removeMcp(storage: McpDemoStorage, id: string): DemoMcpInstallation[] {
  const next = loadSavedMcps(storage).filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(candidate) => candidate.id !== id);
  storage.setItem(demoMcpStorageKey, JSON.stringify(next));
  storage.setItem(demoMcpRemovedStorageKey, JSON.stringify([...new Set([...loadRemovedMcpIds(storage), id])]));
  return next;
}

/** 读取「loadRemovedMcpIds」所需数据，并遵守作用域、分页与容量边界。 */
export function loadRemovedMcpIds(storage: Pick<McpDemoStorage, "getItem">): string[] {
  const raw = storage.getItem(demoMcpRemovedStorageKey);
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** 汇总「mergeMcpInstallations」对应指标，保持缺失字段语义且不重复计算同一来源。 */
export function mergeMcpInstallations(saved: DemoMcpInstallation[], builtIns: DemoMcpInstallation[], removedIds: string[] = []): DemoMcpInstallation[] {
  const savedIds = new Set(saved.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(installation) => installation.id));
  const removed = new Set(removedIds);
  return [...saved, ...builtIns.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(installation) => !savedIds.has(installation.id) && !removed.has(installation.id))];
}

/** 执行「boundMcpIds」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function boundMcpIds(agent: DemoAgentStrategy): string[] {
  const module = agent.modules.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(candidate) => candidate.id === "mcp");
  if (!module?.enabled) return [];
  return [...(module.selectedItems ?? [])];
}

/** 执行「projectStreamForAgent」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function projectStreamForAgent(
  items: DemoStreamItem[],
  agent: DemoAgentStrategy,
  installations: DemoMcpInstallation[],
): DemoStreamItem[] {
  const boundIds = new Set(boundMcpIds(agent));
  const allowed = installations.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(installation) => boundIds.has(installation.id) && installation.state === "ready");
  const allowedIds = new Set(allowed.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(installation) => installation.id));
  const allowedNames = allowed.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(installation) => installation.name);
  return items.flatMap(/** 执行「projectStreamForAgent」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(item): DemoStreamItem[] => {
    if (item.type === "tool" && item.requiredMcpId && !allowedIds.has(item.requiredMcpId)) return [];
    if (item.type === "mcp_boundary") return [{
      ...item,
      agentName: agent.name,
      allowedMcps: allowed.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(installation) => ({
        id: installation.id,
        name: installation.name,
        toolCount: installation.capabilities.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(capability) => capability.kind === "tool").length,
      })),
      excludedCount: installations.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(installation) => !allowedIds.has(installation.id)).length,
    }];
    if (item.type === "context") {
      const mcpTokens = allowed.reduce(/** 把当前元素归并到有限累加状态，避免额外复制完整集合。 */
(total, installation) => total + Math.max(42, installation.capabilities.length * 34), 0);
      const nextItems = item.items.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(contextItem) => contextItem.id === "ctx-mcp" ? {
        ...contextItem,
        detail: allowedNames.length > 0 ? allowedNames.join(" · ") : "当前 Agent 未绑定 MCP",
        tokens: mcpTokens,
        raw: JSON.stringify(allowed.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(installation) => ({
          serverId: installation.id,
          tools: installation.capabilities.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(capability) => capability.kind === "tool").map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(capability) => capability.name),
        })), null, 2),
      } : contextItem);
      return [{ ...item, items: nextItems, totalTokens: nextItems.reduce(/** 把当前元素归并到有限累加状态，避免额外复制完整集合。 */
(total, contextItem) => total + contextItem.tokens, 0) }];
    }
    if (item.type === "assistant" && item.projectionKey === "mcp-demo-summary") {
      const markdown = allowed.length === 0
        ? "当前 Agent 没有绑定可用的远程 MCP，因此本轮不会向模型暴露任何 MCP Tool Schema。请先在 Agent 配置中选择 MCP。"
        : `本轮只使用了当前 Agent 已配置的远程 MCP：**${allowedNames.join("**、**")}**。未绑定或已停用的 MCP 没有进入 Tool Registry，也不会被模型调用。`;
      return [{ ...item, markdown, outputTokens: allowed.length === 0 ? 38 : 56 }];
    }
    return [item];
  });
}

/** 执行「mcpStateLabel」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function mcpStateLabel(state: DemoMcpInstallation["state"]): string {
  if (state === "ready") return "可用";
  if (state === "reconnecting") return "重连中";
  if (state === "auth_required") return "需认证";
  if (state === "failed") return "连接失败";
  return "已停用";
}

/** 判断「isMcpInstallation」对应条件，只返回判定结果且不修改输入状态。 */
function isMcpInstallation(value: unknown): value is DemoMcpInstallation {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DemoMcpInstallation>;
  return typeof candidate.id === "string"
    && typeof candidate.name === "string"
    && typeof candidate.url === "string"
    && candidate.transport === "streamable_http"
    && (candidate.authKind === "none" || candidate.authKind === "bearer")
    && Array.isArray(candidate.capabilities)
    && Array.isArray(candidate.boundAgentIds);
}
