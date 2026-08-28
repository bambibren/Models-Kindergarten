import type { McpInstallationView, McpTestRecord } from "@kindergarten/contracts";
import { AtomicJsonStore } from "../storage/atomic-json-store.js";

/** 描述「McpManagementRepository」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export class McpManagementRepository {
  private readonly tests: AtomicJsonStore<McpTestRecord>;
  private readonly installations: AtomicJsonStore<McpInstallationView>;

  /** 初始化「McpManagementRepository」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(testsFile: string, installationsFile: string) {
    this.tests = new AtomicJsonStore({ file: testsFile, schemaVersion: 1, validate: isTest });
    this.installations = new AtomicJsonStore({ file: installationsFile, schemaVersion: 1, validate: isInstallation });
  }

  /** 读取「listTests」所需数据，并遵守作用域、分页与容量边界。 */
async listTests(): Promise<McpTestRecord[]> {
    const now = Date.now();
    return (await this.tests.update(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(records) => {
      const active = records.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => !isExpired(item.expiresAt, now));
      return { records: active, result: structuredClone(active) };
    })) ?? [];
  }
  /** 读取「listInstallations」所需数据，并遵守作用域、分页与容量边界。 */
listInstallations(): Promise<McpInstallationView[]> { return this.installations.read(); }

  /** 读取「getTest」所需数据，并遵守作用域、分页与容量边界。 */
async getTest(id: string): Promise<McpTestRecord | undefined> {
    const now = Date.now();
    return this.tests.update(/** 读取「getTest」所需数据，并遵守作用域、分页与容量边界。 */
(records) => {
      const item = records.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(candidate) => candidate.testId === id);
      return {
        records: records.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(candidate) => !isExpired(candidate.expiresAt, now)),
        result: item ? structuredClone(item) : undefined,
      };
    });
  }

  /** 读取「getInstallation」所需数据，并遵守作用域、分页与容量边界。 */
async getInstallation(id: string): Promise<McpInstallationView | undefined> {
    return (await this.installations.read()).find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.mcpInstallationId === id);
  }

  /** 更新「putTest」对应状态，并保持写入顺序、原子性与容量约束。 */
async putTest(value: McpTestRecord): Promise<void> {
    const now = Date.now();
    await this.tests.update(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(records) => {
      const active = records.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.testId !== value.testId && !isExpired(item.expiresAt, now));
      return isExpired(value.expiresAt, now) ? active : [...active, structuredClone(value)];
    });
  }

  /** 更新「putInstallation」对应状态，并保持写入顺序、原子性与容量约束。 */
async putInstallation(value: McpInstallationView): Promise<void> {
    await this.installations.update(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(records) => [
      ...records.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.mcpInstallationId !== value.mcpInstallationId), value,
    ]);
  }

  /** 释放或删除「removeInstallation」对应资源，重复调用仍保持安全。 */
async removeInstallation(id: string): Promise<void> {
    await this.installations.update(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(records) => records.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.mcpInstallationId !== id));
  }
}

/** 非法时间与到期时间都视为不可继续保留。 */
function isExpired(expiresAt: string, now: number): boolean {
  const timestamp = Date.parse(expiresAt);
  return !Number.isFinite(timestamp) || timestamp <= now;
}

/** 判断「isTest」对应条件，只返回判定结果且不修改输入状态。 */
function isTest(value: unknown): value is McpTestRecord {
  if (!record(value)) return false;
  return value.schemaVersion === 1 && typeof value.testId === "string" && typeof value.ownerId === "string" &&
    typeof value.candidateHash === "string" && record(value.candidate) && typeof value.state === "string" &&
    typeof value.createdAt === "string" && typeof value.expiresAt === "string";
}

/** 判断「isInstallation」对应条件，只返回判定结果且不修改输入状态。 */
function isInstallation(value: unknown): value is McpInstallationView {
  if (!record(value)) return false;
  return value.schemaVersion === 1 && typeof value.mcpInstallationId === "string" && typeof value.ownerId === "string" &&
    typeof value.name === "string" && typeof value.url === "string" && typeof value.state === "string" &&
    typeof value.createdAt === "string" && typeof value.updatedAt === "string";
}

/** 更新「record」对应状态，并保持写入顺序、原子性与容量约束。 */
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
