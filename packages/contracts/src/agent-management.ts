import { isRecord, optionalString, requiredString } from "./common.js";
import { PRODUCT_CONFIG } from "./product-config.js";

export type ToolPermission = "allow" | "ask" | "deny";

export interface BuiltinToolBinding {
  toolId: string;
  enabled: boolean;
  permission: ToolPermission;
}

export interface SkillBinding {
  skillInstallationId: string;
  enabled: boolean;
}

export interface McpToolBinding {
  remoteName: string;
  enabled: boolean;
  permission: ToolPermission;
}

export interface McpResourceBinding {
  uri: string;
  enabled: boolean;
  preload: boolean;
}

export interface McpBinding {
  mcpInstallationId: string;
  enabled: boolean;
  tools: McpToolBinding[];
  resources: McpResourceBinding[];
}

export type HistoryPolicy =
  | { mode: "none" }
  | { mode: "recent_turns"; maxTurns: number };

export interface AgentInput {
  name: string;
  description?: string;
  systemPrompt: string;
  builtinTools: BuiltinToolBinding[];
  skillInstallationIds: string[];
  mcps: McpBinding[];
  historyPolicy: HistoryPolicy;
  memoryPolicy: { mode: "off" };
}

export interface AgentRecord extends Omit<AgentInput, "skillInstallationIds"> {
  schemaVersion: 1;
  agentId: string;
  ownerId: string;
  recordKind?: "user" | "experiment_policy";
  skills: SkillBinding[];
  createdAt: string;
  updatedAt: string;
  deletable?: boolean;
}

export function parseAgentInput(value: unknown): AgentInput {
  if (!isRecord(value)) throw new Error("AgentInput 必须是对象");
  if (!Array.isArray(value.builtinTools)) throw new Error("builtinTools 必须是数组");
  if (!Array.isArray(value.skillInstallationIds)) throw new Error("skillInstallationIds 必须是数组");
  if (!Array.isArray(value.mcps)) throw new Error("mcps 必须是数组");
  const description = optionalString(value, "description", { max: PRODUCT_CONFIG.agent.descriptionMaxCharacters });
  return canonicalAgentInput({
    name: requiredString(value, "name", { max: PRODUCT_CONFIG.agent.nameMaxCharacters }),
    ...(description ? { description } : {}),
    systemPrompt: requiredString(value, "systemPrompt", {
      max: PRODUCT_CONFIG.agent.systemPromptMaxCharacters,
      preserveWhitespace: true,
    }),
    builtinTools: value.builtinTools.map(parseBuiltinToolBinding),
    skillInstallationIds: value.skillInstallationIds.map((id) => {
      if (typeof id !== "string" || id.trim().length === 0) throw new Error("skillInstallationIds 包含无效 ID");
      return id.trim();
    }),
    mcps: value.mcps.map(parseMcpBinding),
    historyPolicy: parseHistoryPolicy(value.historyPolicy),
    memoryPolicy: parseMemoryPolicy(value.memoryPolicy),
  });
}

export function canonicalAgentInput(input: AgentInput): AgentInput {
  const builtin = new Map<string, BuiltinToolBinding>();
  for (const item of input.builtinTools) {
    const current = builtin.get(item.toolId);
    if (current && (current.enabled !== item.enabled || current.permission !== item.permission)) {
      throw new Error(`builtinTools 包含冲突配置: ${item.toolId}`);
    }
    builtin.set(item.toolId, item);
  }
  const mcps = input.mcps.toSorted((a, b) => a.mcpInstallationId.localeCompare(b.mcpInstallationId));
  if (new Set(mcps.map((item) => item.mcpInstallationId)).size !== mcps.length) {
    throw new Error("mcps 包含重复 Installation");
  }
  const { description: _description, ...base } = input;
  const description = input.description?.trim();
  return {
    ...base,
    name: input.name.trim(),
    ...(description ? { description } : {}),
    systemPrompt: input.systemPrompt,
    builtinTools: [...builtin.values()].toSorted((a, b) => a.toolId.localeCompare(b.toolId)),
    skillInstallationIds: [...new Set(input.skillInstallationIds)].toSorted(),
    mcps,
  };
}

function parseBuiltinToolBinding(value: unknown): BuiltinToolBinding {
  if (!isRecord(value)) throw new Error("builtinTools 条目必须是对象");
  if (typeof value.enabled !== "boolean") throw new Error("builtinTools.enabled 必须是布尔值");
  return {
    toolId: requiredString(value, "toolId", { max: PRODUCT_CONFIG.agent.toolIdMaxCharacters }),
    enabled: value.enabled,
    permission: parsePermission(value.permission),
  };
}

function parseMcpBinding(value: unknown): McpBinding {
  if (!isRecord(value) || typeof value.enabled !== "boolean") throw new Error("MCP binding 格式无效");
  if (!Array.isArray(value.tools) || !Array.isArray(value.resources)) throw new Error("MCP capability binding 必须是数组");
  return {
    mcpInstallationId: requiredString(value, "mcpInstallationId", {
      max: PRODUCT_CONFIG.agent.mcpInstallationIdMaxCharacters,
    }),
    enabled: value.enabled,
    tools: value.tools.map((item) => {
      if (!isRecord(item) || typeof item.enabled !== "boolean") throw new Error("MCP tool binding 格式无效");
      return {
        remoteName: requiredString(item, "remoteName", {
          max: PRODUCT_CONFIG.agent.mcpRemoteToolNameMaxCharacters,
        }),
        enabled: item.enabled,
        permission: parsePermission(item.permission),
      };
    }),
    resources: value.resources.map((item) => {
      if (!isRecord(item) || typeof item.enabled !== "boolean" || typeof item.preload !== "boolean") {
        throw new Error("MCP resource binding 格式无效");
      }
      return {
        uri: requiredString(item, "uri", { max: PRODUCT_CONFIG.agent.mcpResourceUriMaxCharacters }),
        enabled: item.enabled,
        preload: item.preload,
      };
    }),
  };
}

function parsePermission(value: unknown): ToolPermission {
  if (value === "allow" || value === "ask" || value === "deny") return value;
  throw new Error("permission 必须是 allow、ask 或 deny");
}

function parseHistoryPolicy(value: unknown): HistoryPolicy {
  if (!isRecord(value)) throw new Error("historyPolicy 必须是对象");
  if (value.mode === "none") return { mode: "none" };
  if (value.mode === "recent_turns" && Number.isInteger(value.maxTurns) && Number(value.maxTurns) >= 0 &&
    Number(value.maxTurns) <= PRODUCT_CONFIG.agent.historyRecentTurnsMax) {
    return { mode: "recent_turns", maxTurns: Number(value.maxTurns) };
  }
  throw new Error("historyPolicy 格式无效");
}

function parseMemoryPolicy(value: unknown): { mode: "off" } {
  if (isRecord(value) && value.mode === "off") return { mode: "off" };
  throw new Error("memoryPolicy 首版只能为 off");
}
