import { PRODUCT_CONFIG, type SkillInstallJob, type SkillInstallation } from "@kindergarten/contracts";
import { AtomicJsonStore } from "../storage/atomic-json-store.js";

/** 描述「SkillInstallationRepository」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export class SkillInstallationRepository {
  private readonly installations: AtomicJsonStore<SkillInstallation>;
  private readonly jobs: AtomicJsonStore<SkillInstallJob>;

  /** 初始化「SkillInstallationRepository」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(installationsFile: string, jobsFile: string) {
    this.installations = new AtomicJsonStore({
      file: installationsFile,
      schemaVersion: 1,
      validate: isInstallation,
    });
    this.jobs = new AtomicJsonStore({ file: jobsFile, schemaVersion: 1, validate: isJob });
  }

  /** 读取「listInstallations」所需数据，并遵守作用域、分页与容量边界。 */
listInstallations(): Promise<SkillInstallation[]> {
    return this.installations.read();
  }

  /** 读取「getInstallation」所需数据，并遵守作用域、分页与容量边界。 */
async getInstallation(id: string): Promise<SkillInstallation | undefined> {
    return (await this.installations.read()).find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.skillInstallationId === id);
  }

  /** 更新「putInstallation」对应状态，并保持写入顺序、原子性与容量约束。 */
async putInstallation(value: SkillInstallation): Promise<void> {
    await this.installations.update(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(records) => {
      const next = records.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.skillInstallationId !== value.skillInstallationId);
      next.push(value);
      return next;
    });
  }

  /** 释放或删除「removeInstallation」对应资源，重复调用仍保持安全。 */
async removeInstallation(id: string): Promise<void> {
    await this.installations.update(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(records) => records.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.skillInstallationId !== id));
  }

  /** 读取「listJobs」所需数据，并遵守作用域、分页与容量边界。 */
listJobs(): Promise<SkillInstallJob[]> {
    return this.jobs.read();
  }

  /** 读取「getJob」所需数据，并遵守作用域、分页与容量边界。 */
async getJob(id: string): Promise<SkillInstallJob | undefined> {
    return (await this.jobs.read()).find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.jobId === id);
  }

  /** 更新「putJob」对应状态，并保持写入顺序、原子性与容量约束。 */
async putJob(value: SkillInstallJob): Promise<void> {
    await this.jobs.update(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(records) => {
      const next = records.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.jobId !== value.jobId);
      next.push(value);
      return retainRecentTerminalJobs(next);
    });
  }

  /** 执行「interruptActiveJobs」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async interruptActiveJobs(): Promise<number> {
    return (await this.jobs.update(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(records) => {
      const now = new Date().toISOString();
      let count = 0;
      const next = records.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(job) => {
        if (job.state !== "queued" && job.state !== "running") return job;
        count += 1;
        return {
          ...job,
          state: "interrupted" as const,
          items: job.items.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) =>
            item.state === "queued" || item.state === "validating" || item.state === "installing"
              ? {
                  ...item,
                  state: "failed" as const,
                  error: {
                    code: "SKILL_JOB_INTERRUPTED" as const,
                    message: "Remote 服务重启，Skill 安装已中断，可重新提交安装",
                    retryable: true,
                  },
                }
              : item),
          updatedAt: now,
          completedAt: now,
        };
      });
      return { records: retainRecentTerminalJobs(next), result: count };
    })) ?? 0;
  }
}

/** 活动作业全部保留；每个 owner 的终态作业仅保留最近固定数量。 */
function retainRecentTerminalJobs(records: SkillInstallJob[]): SkillInstallJob[] {
  const terminalByOwner = new Map<string, SkillInstallJob[]>();
  for (const job of records) {
    if (!isTerminalJob(job)) continue;
    const ownerJobs = terminalByOwner.get(job.ownerId) ?? [];
    ownerJobs.push(job);
    terminalByOwner.set(job.ownerId, ownerJobs);
  }
  const retainedIds = new Set<string>();
  for (const ownerJobs of terminalByOwner.values()) {
    ownerJobs
      .sort(/** 按稳定业务键比较两个元素，供调用方生成确定顺序。 */
(left, right) => Date.parse(right.completedAt ?? right.updatedAt) - Date.parse(left.completedAt ?? left.updatedAt))
      .slice(0, PRODUCT_CONFIG.capacity.maxTerminalSkillInstallJobsPerOwner)
      .forEach(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(job) => retainedIds.add(job.jobId));
  }
  return records.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(job) => !isTerminalJob(job) || retainedIds.has(job.jobId));
}

/** queued/running 是唯一活动状态，其余状态都已经终止。 */
function isTerminalJob(job: SkillInstallJob): boolean {
  return job.state !== "queued" && job.state !== "running";
}

/** 判断「isInstallation」对应条件，只返回判定结果且不修改输入状态。 */
function isInstallation(value: unknown): value is SkillInstallation {
  if (!record(value)) return false;
  return value.schemaVersion === 1 && typeof value.skillInstallationId === "string" &&
    typeof value.ownerId === "string" && typeof value.skillName === "string" && typeof value.state === "string" && record(value.source) &&
    typeof value.createdAt === "string" && typeof value.updatedAt === "string";
}

/** 判断「isJob」对应条件，只返回判定结果且不修改输入状态。 */
function isJob(value: unknown): value is SkillInstallJob {
  if (!record(value)) return false;
  return value.schemaVersion === 1 && typeof value.jobId === "string" && typeof value.ownerId === "string" &&
    typeof value.state === "string" && Array.isArray(value.items) && typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string";
}

/** 更新「record」对应状态，并保持写入顺序、原子性与容量约束。 */
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
