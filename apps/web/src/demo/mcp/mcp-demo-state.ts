import type { DemoAgentStrategy, DemoMcpInstallation, DemoStreamItem } from "../demo-types.js";

export const demoMcpStorageKey = "models-kindergarten.demo-mcps";
export const demoMcpRemovedStorageKey = "models-kindergarten.demo-mcps.removed";

export interface McpDemoStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

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

export function saveMcp(storage: McpDemoStorage, installation: DemoMcpInstallation): DemoMcpInstallation[] {
  const current = loadSavedMcps(storage);
  const next = [installation, ...current.filter((candidate) => candidate.id !== installation.id)];
  storage.setItem(demoMcpStorageKey, JSON.stringify(next));
  const removed = loadRemovedMcpIds(storage).filter((id) => id !== installation.id);
  storage.setItem(demoMcpRemovedStorageKey, JSON.stringify(removed));
  return next;
}

export function removeMcp(storage: McpDemoStorage, id: string): DemoMcpInstallation[] {
  const next = loadSavedMcps(storage).filter((candidate) => candidate.id !== id);
  storage.setItem(demoMcpStorageKey, JSON.stringify(next));
  storage.setItem(demoMcpRemovedStorageKey, JSON.stringify([...new Set([...loadRemovedMcpIds(storage), id])]));
  return next;
}

export function loadRemovedMcpIds(storage: Pick<McpDemoStorage, "getItem">): string[] {
  const raw = storage.getItem(demoMcpRemovedStorageKey);
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function mergeMcpInstallations(saved: DemoMcpInstallation[], builtIns: DemoMcpInstallation[], removedIds: string[] = []): DemoMcpInstallation[] {
  const savedIds = new Set(saved.map((installation) => installation.id));
  const removed = new Set(removedIds);
  return [...saved, ...builtIns.filter((installation) => !savedIds.has(installation.id) && !removed.has(installation.id))];
}

export function boundMcpIds(agent: DemoAgentStrategy): string[] {
  const module = agent.modules.find((candidate) => candidate.id === "mcp");
  if (!module?.enabled) return [];
  return [...(module.selectedItems ?? [])];
}

export function projectStreamForAgent(
  items: DemoStreamItem[],
  agent: DemoAgentStrategy,
  installations: DemoMcpInstallation[],
): DemoStreamItem[] {
  const boundIds = new Set(boundMcpIds(agent));
  const allowed = installations.filter((installation) => boundIds.has(installation.id) && installation.state === "ready");
  const allowedIds = new Set(allowed.map((installation) => installation.id));
  const allowedNames = allowed.map((installation) => installation.name);
  return items.flatMap((item): DemoStreamItem[] => {
    if (item.type === "tool" && item.requiredMcpId && !allowedIds.has(item.requiredMcpId)) return [];
    if (item.type === "mcp_boundary") return [{
      ...item,
      agentName: agent.name,
      allowedMcps: allowed.map((installation) => ({
        id: installation.id,
        name: installation.name,
        toolCount: installation.capabilities.filter((capability) => capability.kind === "tool").length,
      })),
      excludedCount: installations.filter((installation) => !allowedIds.has(installation.id)).length,
    }];
    if (item.type === "context") {
      const mcpTokens = allowed.reduce((total, installation) => total + Math.max(42, installation.capabilities.length * 34), 0);
      const nextItems = item.items.map((contextItem) => contextItem.id === "ctx-mcp" ? {
        ...contextItem,
        detail: allowedNames.length > 0 ? allowedNames.join(" · ") : "当前 Agent 未绑定 MCP",
        tokens: mcpTokens,
        raw: JSON.stringify(allowed.map((installation) => ({
          serverId: installation.id,
          tools: installation.capabilities.filter((capability) => capability.kind === "tool").map((capability) => capability.name),
        })), null, 2),
      } : contextItem);
      return [{ ...item, items: nextItems, totalTokens: nextItems.reduce((total, contextItem) => total + contextItem.tokens, 0) }];
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

export function mcpStateLabel(state: DemoMcpInstallation["state"]): string {
  if (state === "ready") return "可用";
  if (state === "reconnecting") return "重连中";
  if (state === "auth_required") return "需认证";
  if (state === "failed") return "连接失败";
  return "已停用";
}

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
