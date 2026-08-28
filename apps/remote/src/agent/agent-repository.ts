import type { AgentRecord } from "@kindergarten/contracts";
import { AtomicJsonStore } from "../storage/atomic-json-store.js";

/** 描述「AgentRepository」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export class AgentRepository {
  private readonly store: AtomicJsonStore<AgentRecord>;

  /** 初始化「AgentRepository」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(file: string) {
    this.store = new AtomicJsonStore({ file, schemaVersion: 1, validate: isAgentRecord });
  }

  /** 执行「all」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
all(): Promise<AgentRecord[]> {
    return this.store.read();
  }

  /** 读取「get」所需数据，并遵守作用域、分页与容量边界。 */
async get(agentId: string): Promise<AgentRecord | undefined> {
    const record = (await this.store.read()).find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.agentId === agentId);
    return record;
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
      const record = change(structuredClone(current));
      const next = [...records];
      next[index] = record;
      return { records: next, result: record };
    });
    if (!result) throw new Error(`Agent 不存在: ${agentId}`);
    return result;
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
    Array.isArray(item.skills) && Array.isArray(item.mcps) &&
    !("defaultReasoningProfile" in item) &&
    typeof item.createdAt === "string" && typeof item.updatedAt === "string";
}
