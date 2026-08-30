import { isRecord, optionalString, requiredString } from "./common.js";
import { PRODUCT_CONFIG } from "./product-config.js";

/** 描述「ToolPermission」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ToolPermission = "allow" | "ask" | "deny";

/** 描述「BuiltinToolBinding」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface BuiltinToolBinding {
  toolId: string;
  enabled: boolean;
  permission: ToolPermission;
}

/** 描述「SkillBinding」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface SkillBinding {
  skillInstallationId: string;
  enabled: boolean;
}

/** 描述「McpToolBinding」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface McpToolBinding {
  remoteName: string;
  enabled: boolean;
  permission: ToolPermission;
}

/** 描述「McpResourceBinding」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface McpResourceBinding {
  uri: string;
  enabled: boolean;
  preload: boolean;
}

/** 描述「McpBinding」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface McpBinding {
  mcpInstallationId: string;
  enabled: boolean;
  tools: McpToolBinding[];
  resources: McpResourceBinding[];
}

/** 描述「HistoryPolicy」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type HistoryPolicy =
  | { mode: "none" }
  | { mode: "recent_turns"; maxTurns: number };

/** 描述「AgentInput」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
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

/** 描述「AgentRecord」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface AgentRecord extends Omit<AgentInput, "skillInstallationIds"> {
  schemaVersion: 1;
  agentId: string;
  ownerId: string;
  recordKind?: "user" | "system_default" | "experiment_policy";
  skills: SkillBinding[];
  createdAt: string;
  updatedAt: string;
  deletable?: boolean;
}

/** 校验并规范化「parseAgentInput」输入，非法数据直接返回明确错误。 */
export function parseAgentInput(value: unknown): AgentInput {
  if (!isRecord(value)) throw new Error("AgentInput 必须是对象");
  if (!Array.isArray(value.builtinTools)) throw new Error("builtinTools 必须是数组");
  if (!Array.isArray(value.skillInstallationIds)) throw new Error("skillInstallationIds 必须是数组");
  if (!Array.isArray(value.mcps)) throw new Error("mcps 必须是数组");
  const description = optionalString(value, "description", { max: PRODUCT_CONFIG.agent.descriptionMaxCharacters });
  const parsed = canonicalAgentInput({
    name: requiredString(value, "name", { max: PRODUCT_CONFIG.agent.nameMaxCharacters }),
    ...(description ? { description } : {}),
    systemPrompt: requiredString(value, "systemPrompt", {
      max: PRODUCT_CONFIG.agent.systemPromptMaxCharacters,
      preserveWhitespace: true,
    }),
    builtinTools: value.builtinTools.map(parseBuiltinToolBinding),
    skillInstallationIds: value.skillInstallationIds.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(id) => {
      if (typeof id !== "string" || id.trim().length === 0) throw new Error("skillInstallationIds 包含无效 ID");
      return id.trim();
    }),
    mcps: value.mcps.map(parseMcpBinding),
    historyPolicy: parseHistoryPolicy(value.historyPolicy),
    memoryPolicy: parseMemoryPolicy(value.memoryPolicy),
  });
  const enabledBuiltinTools = parsed.builtinTools.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.enabled).length;
  const enabledMcpTools = parsed.mcps
    .filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.enabled)
    .reduce(/** 把当前元素归并到有限累加状态，避免额外复制完整集合。 */
(total, item) => total + item.tools.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(tool) => tool.enabled).length, 0);
  if (parsed.skillInstallationIds.length > PRODUCT_CONFIG.capacity.maxAgentSkills) {
    throw new Error(`Agent 绑定 Skill 超过 ${PRODUCT_CONFIG.capacity.maxAgentSkills} 个上限`);
  }
  if (parsed.mcps.length > PRODUCT_CONFIG.capacity.maxAgentMcps) {
    throw new Error(`Agent 绑定 MCP Installation 超过 ${PRODUCT_CONFIG.capacity.maxAgentMcps} 个上限`);
  }
  if (enabledBuiltinTools + enabledMcpTools > PRODUCT_CONFIG.capacity.maxAgentBoundTools) {
    throw new Error(`Agent 启用 Tool 超过 ${PRODUCT_CONFIG.capacity.maxAgentBoundTools} 个上限`);
  }
  return parsed;
}

/** 判断「canonicalAgentInput」对应条件，只返回判定结果且不修改输入状态。 */
export function canonicalAgentInput(input: AgentInput): AgentInput {
  const builtin = new Map<string, BuiltinToolBinding>();
  for (const item of input.builtinTools) {
    const current = builtin.get(item.toolId);
    if (current && (current.enabled !== item.enabled || current.permission !== item.permission)) {
      throw new Error(`builtinTools 包含冲突配置: ${item.toolId}`);
    }
    builtin.set(item.toolId, item);
  }
  const mcps = input.mcps.toSorted(/** 执行「mcps」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(a, b) => a.mcpInstallationId.localeCompare(b.mcpInstallationId));
  if (new Set(mcps.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.mcpInstallationId)).size !== mcps.length) {
    throw new Error("mcps 包含重复 Installation");
  }
  const { description: _description, ...base } = input;
  const description = input.description?.trim();
  return {
    ...base,
    name: input.name.trim(),
    ...(description ? { description } : {}),
    systemPrompt: input.systemPrompt,
    builtinTools: [...builtin.values()].toSorted(/** 执行「builtinTools」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(a, b) => a.toolId.localeCompare(b.toolId)),
    skillInstallationIds: [...new Set(input.skillInstallationIds)].toSorted(),
    mcps,
  };
}

/** 校验并规范化「parseBuiltinToolBinding」输入，非法数据直接返回明确错误。 */
function parseBuiltinToolBinding(value: unknown): BuiltinToolBinding {
  if (!isRecord(value)) throw new Error("builtinTools 条目必须是对象");
  if (typeof value.enabled !== "boolean") throw new Error("builtinTools.enabled 必须是布尔值");
  return {
    toolId: requiredString(value, "toolId", { max: PRODUCT_CONFIG.agent.toolIdMaxCharacters }),
    enabled: value.enabled,
    permission: parsePermission(value.permission),
  };
}

/** 校验并规范化「parseMcpBinding」输入，非法数据直接返回明确错误。 */
function parseMcpBinding(value: unknown): McpBinding {
  if (!isRecord(value) || typeof value.enabled !== "boolean") throw new Error("MCP binding 格式无效");
  if (!Array.isArray(value.tools) || !Array.isArray(value.resources)) throw new Error("MCP capability binding 必须是数组");
  return {
    mcpInstallationId: requiredString(value, "mcpInstallationId", {
      max: PRODUCT_CONFIG.agent.mcpInstallationIdMaxCharacters,
    }),
    enabled: value.enabled,
    tools: value.tools.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => {
      if (!isRecord(item) || typeof item.enabled !== "boolean") throw new Error("MCP tool binding 格式无效");
      return {
        remoteName: requiredString(item, "remoteName", {
          max: PRODUCT_CONFIG.agent.mcpRemoteToolNameMaxCharacters,
        }),
        enabled: item.enabled,
        permission: parsePermission(item.permission),
      };
    }),
    resources: value.resources.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => {
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

/** 校验并规范化「parsePermission」输入，非法数据直接返回明确错误。 */
function parsePermission(value: unknown): ToolPermission {
  if (value === "allow" || value === "ask" || value === "deny") return value;
  throw new Error("permission 必须是 allow、ask 或 deny");
}

/** 校验并规范化「parseHistoryPolicy」输入，非法数据直接返回明确错误。 */
function parseHistoryPolicy(value: unknown): HistoryPolicy {
  if (!isRecord(value)) throw new Error("historyPolicy 必须是对象");
  if (value.mode === "none") return { mode: "none" };
  if (value.mode === "recent_turns" && Number.isInteger(value.maxTurns) && Number(value.maxTurns) >= 0 &&
    Number(value.maxTurns) <= PRODUCT_CONFIG.agent.historyRecentTurnsMax) {
    return { mode: "recent_turns", maxTurns: Number(value.maxTurns) };
  }
  throw new Error("historyPolicy 格式无效");
}

/** 校验并规范化「parseMemoryPolicy」输入，非法数据直接返回明确错误。 */
function parseMemoryPolicy(value: unknown): { mode: "off" } {
  if (isRecord(value) && value.mode === "off") return { mode: "off" };
  throw new Error("memoryPolicy 首版只能为 off");
}
