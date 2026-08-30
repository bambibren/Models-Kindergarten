import type { AgentRecord, BuiltinToolBinding } from "@kindergarten/contracts";
import { AtomicJsonStore } from "../storage/atomic-json-store.js";

/** 描述「AgentRepository」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export class AgentRepository {
  private readonly store: AtomicJsonStore<AgentRecord>;

  /** 初始化「AgentRepository」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(file: string) {
    this.store = new AtomicJsonStore({ file, schemaVersion: 1, validate: isAgentRecord });
  }

  /** 执行「all」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async all(): Promise<AgentRecord[]> {
    return (await this.store.read()).map(normalizeAgentRecord);
  }

  /** 读取「get」所需数据，并遵守作用域、分页与容量边界。 */
async get(agentId: string): Promise<AgentRecord | undefined> {
    const record = (await this.store.read()).find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.agentId === agentId);
    return record ? normalizeAgentRecord(record) : undefined;
  }

  /** 更新「insert」对应状态，并保持写入顺序、原子性与容量约束。 */
  async insert(record: AgentRecord): Promise<void> {
    await this.store.update(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(records) => {
      if (records.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.agentId === record.agentId)) throw new Error(`Agent 已存在: ${record.agentId}`);
      return [...records, record];
    });
  }

  /** 为账号原子创建唯一系统默认 Agent，并把同名历史记录提升为系统默认记录。 */
  async ensureSystemDefault(record: AgentRecord): Promise<AgentRecord> {
    const result = await this.store.update(/** 更新「result」对应状态，并保持写入顺序、原子性与容量约束。 */
(records) => {
      const index = records.findIndex(/** 执行「index」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(item) => item.ownerId === record.ownerId &&
        (item.recordKind === "system_default" ||
          ((item.recordKind === undefined || item.recordKind === "user") && item.name === record.name)));
      if (index < 0) return { records: [...records, record], result: record };
      const current = records[index];
      if (!current) throw new Error(`默认 Agent 不存在: ${record.ownerId}`);
      if (current.recordKind === "system_default") return { records, result: current };
      const promoted: AgentRecord = { ...current, recordKind: "system_default" };
      const next = [...records];
      next[index] = promoted;
      return { records: next, result: promoted };
    });
    if (!result) throw new Error(`无法创建默认 Agent: ${record.ownerId}`);
    return normalizeAgentRecord(result);
  }

  /** 执行「replace」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async replace(record: AgentRecord): Promise<void> {
    await this.store.update(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(records) => {
      const index = records.findIndex(/** 执行「index」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(item) => item.agentId === record.agentId);
      if (index < 0) throw new Error(`Agent 不存在: ${record.agentId}`);
      const next = [...records];
      next[index] = record;
      return next;
    });
  }

  /** 更新「update」对应状态，并保持写入顺序、原子性与容量约束。 */
async update(agentId: string, change: (record: AgentRecord) => AgentRecord): Promise<AgentRecord> {
    const result = await this.store.update(/** 执行「result」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(records) => {
      const index = records.findIndex(/** 执行「index」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(item) => item.agentId === agentId);
      if (index < 0) throw new Error(`Agent 不存在: ${agentId}`);
      const current = records[index];
      if (!current) throw new Error(`Agent 不存在: ${agentId}`);
      const record = change(structuredClone(normalizeAgentRecord(current)));
      const next = [...records];
      next[index] = record;
      return { records: next, result: record };
    });
    if (!result) throw new Error(`Agent 不存在: ${agentId}`);
    return result;
  }

  /** 原子迁移旧 Builtin Installation 引用，并补齐新增的绑定字段。 */
  async migrateBuiltinSkills(byInstallationId: ReadonlyMap<string, string>): Promise<AgentRecord[]> {
    const result = await this.store.update((records) => {
      const migrated = records.map((record) => {
        const current = normalizeAgentRecord(record);
        const builtin = new Map(current.builtinSkills.map((item) => [item.skillId, item]));
        const installed: AgentRecord["skills"] = [];
        for (const binding of current.skills) {
          const skillId = byInstallationId.get(binding.skillInstallationId);
          if (!skillId) {
            installed.push(binding);
            continue;
          }
          const existing = builtin.get(skillId);
          builtin.set(skillId, { skillId, enabled: (existing?.enabled ?? false) || binding.enabled });
        }
        return {
          ...current,
          builtinSkills: [...builtin.values()].toSorted((left, right) => left.skillId.localeCompare(right.skillId)),
          skills: installed,
        };
      });
      return { records: migrated, result: migrated };
    });
    return result ?? [];
  }

  /** 原子补齐所有账号系统默认 Agent 缺失的内置工具；已有绑定视为用户选择并保持不变。 */
  async migrateSystemDefaultTools(defaults: readonly BuiltinToolBinding[]): Promise<AgentRecord[]> {
    const result = await this.store.update((records) => {
      const updated: AgentRecord[] = [];
      const migrated = records.map((record) => {
        const current = normalizeAgentRecord(record);
        if (current.recordKind !== "system_default") return record;
        const bound = new Set(current.builtinTools.map((item) => item.toolId));
        const additions = defaults.filter((item) => !bound.has(item.toolId));
        if (additions.length === 0) return record;
        const next: AgentRecord = {
          ...current,
          builtinTools: [...current.builtinTools, ...additions]
            .toSorted((left, right) => left.toolId.localeCompare(right.toolId)),
          updatedAt: new Date().toISOString(),
        };
        updated.push(next);
        return next;
      });
      return { records: migrated, result: updated };
    });
    return result ?? [];
  }

  /** 释放或删除「remove」对应资源，重复调用仍保持安全。 */
async remove(agentId: string): Promise<void> {
    await this.store.update(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(records) => records.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.agentId !== agentId));
  }
}

/** 判断「isAgentRecord」对应条件，只返回判定结果且不修改输入状态。 */
function isAgentRecord(value: unknown): value is AgentRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Partial<AgentRecord>;
  return item.schemaVersion === 1 && typeof item.agentId === "string" && typeof item.ownerId === "string" &&
    typeof item.name === "string" && typeof item.systemPrompt === "string" && Array.isArray(item.builtinTools) &&
    (item.builtinSkills === undefined || Array.isArray(item.builtinSkills)) &&
    Array.isArray(item.skills) && Array.isArray(item.mcps) &&
    (item.recordKind === undefined || item.recordKind === "user" ||
      item.recordKind === "system_default" || item.recordKind === "experiment_policy") &&
    !("defaultReasoningProfile" in item) &&
    typeof item.createdAt === "string" && typeof item.updatedAt === "string";
}

/** 旧 schemaVersion 1 记录允许缺少新增数组；读取后统一补为空数组。 */
function normalizeAgentRecord(record: AgentRecord): AgentRecord {
  return {
    ...record,
    builtinSkills: Array.isArray(record.builtinSkills) ? structuredClone(record.builtinSkills) : [],
  };
}
