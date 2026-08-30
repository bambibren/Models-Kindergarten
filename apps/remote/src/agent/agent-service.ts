import { randomUUID } from "node:crypto";
import {
  canonicalAgentInput,
  parseAgentInput,
  type AgentInput,
  type AgentRecord,
  type CursorPage,
} from "@kindergarten/contracts";
import { ApiProblemError } from "../server/api-problem.js";
import type { AgentRepository } from "./agent-repository.js";

/** 描述「AgentCapabilitySource」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface AgentCapabilitySource {
  builtinToolIds(): string[];
  readySkillInstallationIds(ownerId: string): Promise<string[]>;
  mcpCapabilities(ownerId: string): Promise<Array<{ installationId: string; tools: string[]; resources: string[] }>>;
  skillInstallationIds?(ownerId: string): Promise<string[]>;
  mcpInstallationIds?(ownerId: string): Promise<string[]>;
}

/** 描述「AgentService」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export class AgentService {
  private readonly protectedIds = new Set<string>();
  /** 初始化「AgentService」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(
    private readonly repository: AgentRepository,
    private readonly capabilities: AgentCapabilitySource,
  ) {}

  /** 执行「protect」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
  protect(agentId: string): void { this.protectedIds.add(agentId); }

  /** 确保每个账号都有且只有一个系统默认 Agent；该记录不绑定任何 ModelStudent。 */
  async ensureDefault(raw: unknown, ownerId = "local-admin"): Promise<AgentRecord> {
    const input = await this.validate(raw, ownerId);
    const now = new Date().toISOString();
    const record = await this.repository.ensureSystemDefault({
      schemaVersion: 1,
      agentId: randomUUID(),
      ownerId,
      recordKind: "system_default",
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      systemPrompt: input.systemPrompt,
      builtinTools: input.builtinTools,
      skills: input.skillInstallationIds.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(skillInstallationId) => ({ skillInstallationId, enabled: true })),
      mcps: input.mcps,
      historyPolicy: input.historyPolicy,
      memoryPolicy: input.memoryPolicy,
      createdAt: now,
      updatedAt: now,
    });
    this.protect(record.agentId);
    return { ...structuredClone(record), deletable: false };
  }

  /** 根据已校验输入构建「create」结果，不额外持有调用方的大对象。 */
async create(raw: unknown, ownerId = "local-admin"): Promise<AgentRecord> {
    const input = await this.validate(raw, ownerId);
    const now = new Date().toISOString();
    const record: AgentRecord = {
      schemaVersion: 1,
      agentId: randomUUID(),
      ownerId,
      recordKind: "user",
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      systemPrompt: input.systemPrompt,
      builtinTools: input.builtinTools,
      skills: input.skillInstallationIds.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(skillInstallationId) => ({ skillInstallationId, enabled: true })),
      mcps: input.mcps,
      historyPolicy: input.historyPolicy,
      memoryPolicy: input.memoryPolicy,
      createdAt: now,
      updatedAt: now,
    };
    await this.repository.insert(record);
    return { ...structuredClone(record), deletable: true };
  }

  /** 读取「get」所需数据，并遵守作用域、分页与容量边界。 */
  async get(agentId: string, ownerId = "local-admin"): Promise<AgentRecord> {
    const record = await this.repository.get(agentId);
    if (!record || record.ownerId !== ownerId) throw new ApiProblemError(404, "NOT_FOUND", "Agent 不存在", false);
    return { ...record, deletable: this.deletable(record) };
  }

  /** 读取「list」所需数据，并遵守作用域、分页与容量边界。 */
async list(options: { query?: string; cursor?: string; limit?: number }, ownerId = "local-admin"): Promise<CursorPage<AgentRecord>> {
    const query = options.query?.trim().toLocaleLowerCase() ?? "";
    const limit = Math.max(1, Math.min(100, options.limit ?? 20));
    const offset = decodeCursor(options.cursor);
    const records = (await this.repository.all())
      .filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.ownerId === ownerId)
      .filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.recordKind !== "experiment_policy")
      .filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => !query || `${item.name}\n${item.description ?? ""}`.toLocaleLowerCase().includes(query))
      .toSorted(/** 更新「records」对应状态，并保持写入顺序、原子性与容量约束。 */
(left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.agentId.localeCompare(right.agentId));
    const items = records.slice(offset, offset + limit).map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => ({ ...item, deletable: this.deletable(item) }));
    return {
      items,
      ...(offset + items.length < records.length ? { nextCursor: encodeCursor(offset + items.length) } : {}),
    };
  }

  /** 更新「update」对应状态，并保持写入顺序、原子性与容量约束。 */
async update(agentId: string, raw: unknown, ownerId = "local-admin"): Promise<AgentRecord> {
    const input = await this.validate(raw, ownerId);
    const current = await this.get(agentId, ownerId);
    const record: AgentRecord = {
      schemaVersion: 1,
      agentId,
      ownerId,
      recordKind: current.recordKind ?? "user",
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      systemPrompt: input.systemPrompt,
      builtinTools: input.builtinTools,
      skills: input.skillInstallationIds.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(skillInstallationId) => ({ skillInstallationId, enabled: true })),
      mcps: input.mcps,
      historyPolicy: input.historyPolicy,
      memoryPolicy: input.memoryPolicy,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };
    await this.repository.replace(record);
    return { ...structuredClone(record), deletable: this.deletable(record) };
  }

  /** 释放或删除「delete」对应资源，重复调用仍保持安全。 */
  async delete(agentId: string, ownerId = "local-admin"): Promise<void> {
    const current = await this.get(agentId, ownerId);
    if (current.recordKind === "system_default" || this.protectedIds.has(agentId)) {
      throw new ApiProblemError(409, "CONFLICT", "系统内置 Agent 不可删除", false);
    }
    await this.repository.remove(agentId);
  }

  /** 根据已校验输入构建「createExperimentPolicy」结果，不额外持有调用方的大对象。 */
async createExperimentPolicy(
    experimentId: string,
    variant: import("@kindergarten/contracts").ExperimentVariant,
    ownerId = "local-admin",
  ): Promise<AgentRecord> {
    const input = await this.validate({
      name: `experiment-${experimentId}-${variant.label}`,
      description: "对照实验运行策略；不会出现在 Agent 管理列表",
      ...variant.policy,
    }, ownerId);
    const now = new Date().toISOString();
    const record: AgentRecord = {
      schemaVersion: 1,
      agentId: randomUUID(),
      ownerId,
      recordKind: "experiment_policy",
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      systemPrompt: input.systemPrompt,
      builtinTools: input.builtinTools,
      skills: input.skillInstallationIds.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(skillInstallationId) => ({ skillInstallationId, enabled: true })),
      mcps: input.mcps,
      historyPolicy: input.historyPolicy,
      memoryPolicy: input.memoryPolicy,
      createdAt: now,
      updatedAt: now,
    };
    await this.repository.insert(record);
    return record;
  }

  /** 汇总「mergeReadySkills」对应指标，保持缺失字段语义且不重复计算同一来源。 */
async mergeReadySkills(agentId: string, installationIds: string[], ownerId = "local-admin"): Promise<AgentRecord> {
    const ready = new Set(await this.capabilities.readySkillInstallationIds(ownerId));
    for (const id of installationIds) {
      if (!ready.has(id)) throw invalid(`Skill Installation 不可用: ${id}`);
    }
    await this.get(agentId, ownerId);
    return this.repository.update(agentId, /** 汇总「mergeReadySkills」对应指标，保持缺失字段语义且不重复计算同一来源。 */
(record) => {
      const ids = new Set(record.skills.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.enabled).map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.skillInstallationId));
      installationIds.forEach(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(id) => ids.add(id));
      return {
        ...record,
        skills: [...ids].toSorted().map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(skillInstallationId) => ({ skillInstallationId, enabled: true })),
        updatedAt: new Date().toISOString(),
      };
    });
  }

  /** 释放或删除「removeMcpBindings」对应资源，重复调用仍保持安全。 */
async removeMcpBindings(installationId: string, ownerId = "local-admin"): Promise<AgentRecord[]> {
    const affected = (await this.repository.all()).filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(record) =>
      record.ownerId === ownerId && record.mcps.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.mcpInstallationId === installationId));
    const updated: AgentRecord[] = [];
    for (const agent of affected) {
      updated.push(await this.repository.update(agent.agentId, /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(record) => ({
        ...record,
        mcps: record.mcps.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.mcpInstallationId !== installationId),
        updatedAt: new Date().toISOString(),
      })));
    }
    return updated;
  }

  /** 释放或删除「removeSkillBindings」对应资源，重复调用仍保持安全。 */
async removeSkillBindings(installationId: string, ownerId = "local-admin"): Promise<AgentRecord[]> {
    const affected = (await this.repository.all()).filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(record) =>
      record.ownerId === ownerId && record.skills.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.skillInstallationId === installationId));
    const updated: AgentRecord[] = [];
    for (const agent of affected) {
      updated.push(await this.repository.update(agent.agentId, /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(record) => ({
        ...record,
        skills: record.skills.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.skillInstallationId !== installationId),
        updatedAt: new Date().toISOString(),
      })));
    }
    return updated;
  }

  /** 执行「capabilityOptions」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async capabilityOptions(ownerId = "local-admin") {
    return {
      builtinTools: this.capabilities.builtinToolIds(),
      readySkillInstallationIds: await this.capabilities.readySkillInstallationIds(ownerId),
      mcps: await this.capabilities.mcpCapabilities(ownerId),
    };
  }

  /** 校验并规范化「validateContextPolicy」输入，非法数据直接返回明确错误。 */
  validateContextPolicy(policy: import("@kindergarten/contracts").ExperimentContextPolicy, ownerId = "local-admin"): Promise<AgentInput> {
    return this.validate({ name: "context-preview", description: "preview only", ...policy }, ownerId);
  }

  /** 清理账号历史 Agent 中已经不属于该账号或已失效的 Skill/MCP 引用。 */
  async reconcileCapabilities(ownerId = "local-admin"): Promise<AgentRecord[]> {
    const readySkillIds = await this.capabilities.readySkillInstallationIds(ownerId);
    const readyMcpCapabilities = await this.capabilities.mcpCapabilities(ownerId);
    const existingSkills = new Set(this.capabilities.skillInstallationIds
      ? await this.capabilities.skillInstallationIds(ownerId)
      : readySkillIds);
    const existingMcps = new Set(this.capabilities.mcpInstallationIds
      ? await this.capabilities.mcpInstallationIds(ownerId)
      : readyMcpCapabilities.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.installationId));
    const affected = (await this.repository.all()).filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(record) => record.ownerId === ownerId && (
      record.skills.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => !existingSkills.has(item.skillInstallationId)) ||
      record.mcps.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => !existingMcps.has(item.mcpInstallationId))
    ));
    const updated: AgentRecord[] = [];
    for (const agent of affected) {
      updated.push(await this.repository.update(agent.agentId, /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(record) => ({
        ...record,
        skills: record.skills.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => existingSkills.has(item.skillInstallationId)),
        mcps: record.mcps.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => existingMcps.has(item.mcpInstallationId)),
        updatedAt: new Date().toISOString(),
      })));
    }
    return updated;
  }

  /** 系统默认记录按持久类型保护；protectedIds 继续兼容进程内显式保护。 */
  private deletable(record: AgentRecord): boolean {
    return record.recordKind !== "system_default" && !this.protectedIds.has(record.agentId);
  }

  /** 校验并规范化「validate」输入，非法数据直接返回明确错误。 */
private async validate(raw: unknown, ownerId: string): Promise<AgentInput> {
    let input: AgentInput;
    try { input = canonicalAgentInput(parseAgentInput(raw)); }
    catch (error) { throw new ApiProblemError(400, "VALIDATION_FAILED", errorText(error), false); }
    const tools = new Set(this.capabilities.builtinToolIds());
    for (const binding of input.builtinTools) if (!tools.has(binding.toolId)) throw invalid(`Built-in Tool 不存在: ${binding.toolId}`);
    const skills = new Set(await this.capabilities.readySkillInstallationIds(ownerId));
    for (const id of input.skillInstallationIds) if (!skills.has(id)) throw invalid(`Skill Installation 不可用: ${id}`);
    const mcps = new Map((await this.capabilities.mcpCapabilities(ownerId)).map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => [item.installationId, item]));
    for (const binding of input.mcps) {
      const snapshot = mcps.get(binding.mcpInstallationId);
      if (!snapshot) throw invalid(`MCP Installation 不可用: ${binding.mcpInstallationId}`);
      for (const tool of binding.tools) if (!snapshot.tools.includes(tool.remoteName)) throw invalid(`MCP Tool 不存在: ${tool.remoteName}`);
      for (const resource of binding.resources) if (!snapshot.resources.includes(resource.uri)) throw invalid(`MCP Resource 不存在: ${resource.uri}`);
    }
    return input;
  }
}

/** 执行「invalid」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function invalid(detail: string): ApiProblemError {
  return new ApiProblemError(400, "CAPABILITY_REFERENCE_INVALID", `CAPABILITY_REFERENCE_INVALID: ${detail}`, false);
}

/** 执行「encodeCursor」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

/** 校验并规范化「decodeCursor」输入，非法数据直接返回明确错误。 */
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const value = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!Number.isInteger(value) || value < 0) throw new ApiProblemError(400, "VALIDATION_FAILED", "cursor 无效", false);
  return value;
}

/** 把未知异常转换为「errorText」文本，避免错误序列化过程再次抛出。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
