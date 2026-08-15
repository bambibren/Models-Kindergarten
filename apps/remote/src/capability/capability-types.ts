import type { PermissionMode } from "../tools/tool-registry.js";

export type CapabilityOrigin = "builtin" | "mcp" | "skill_runtime";

export interface ToolCapabilitySnapshot {
  id: string;
  modelName: string;
  origin: CapabilityOrigin;
  schemaHash: string;
  serverId?: string;
  remoteName?: string;
}

export interface McpServerCapabilitySnapshot {
  serverId: string;
  protocolEra: "modern" | "legacy";
  revision: string;
  toolSchemaHashes: Record<string, string>;
}

export interface SkillCapabilitySnapshot {
  name: string;
  contentHash: string;
  source: "builtin" | "project" | "user" | "git";
}

/**
 * 每个 Prompt Turn 冻结一份能力快照。运行中即使外部目录发生变化，
 * 当前 Turn 的 Tool Schema 和 Skill 版本也不会漂移。
 */
export interface RuntimeCapabilitySnapshot {
  tools: ToolCapabilitySnapshot[];
  mcpServers: McpServerCapabilitySnapshot[];
  skills: SkillCapabilitySnapshot[];
}

export interface AgentCapabilitySet {
  mcpTools: Array<{
    id: string;
    permission: PermissionMode;
  }>;
  skills: string[];
  resources: Array<{
    serverId: string;
    uri: string;
    mode: "metadata" | "preload";
  }>;
}

export const emptyAgentCapabilitySet: AgentCapabilitySet = {
  mcpTools: [],
  skills: [],
  resources: [],
};
