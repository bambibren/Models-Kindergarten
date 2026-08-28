import type { AnyExperimentRecord, ExperimentScorecard } from "@kindergarten/contracts";
import { PartitionedJsonStore } from "../storage/partitioned-json-store.js";

/** 描述「ExperimentRepository」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export class ExperimentRepository {
  private readonly experiments: PartitionedJsonStore<AnyExperimentRecord>;
  private readonly scorecards: PartitionedJsonStore<ExperimentScorecard>;

  /** 初始化「ExperimentRepository」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(experimentsFile: string, scorecardsFile: string) {
    this.experiments = new PartitionedJsonStore({
      legacyFile: experimentsFile,
      recordSchemaVersion: 2,
      legacySchemaVersions: [1],
      idOf: /** 执行「idOf」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(value) => value.experimentId,
      validate: isExperiment,
    });
    this.scorecards = new PartitionedJsonStore({
      legacyFile: scorecardsFile,
      recordSchemaVersion: 1,
      idOf: /** 执行「idOf」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(value) => value.experimentId,
      validate: isScorecard,
    });
  }

  /** 读取「list」所需数据，并遵守作用域、分页与容量边界。 */
list(): Promise<AnyExperimentRecord[]> { return this.experiments.read(); }
  /** 读取「get」所需数据，并遵守作用域、分页与容量边界。 */
get(id: string): Promise<AnyExperimentRecord | undefined> { return this.experiments.get(id); }
  /** 更新「put」对应状态，并保持写入顺序、原子性与容量约束。 */
async put(value: AnyExperimentRecord): Promise<void> {
    await this.experiments.put(structuredClone(value));
  }
  /** 更新「update」对应状态，并保持写入顺序、原子性与容量约束。 */
async update(id: string, change: (value: AnyExperimentRecord) => AnyExperimentRecord): Promise<AnyExperimentRecord> {
    const result = await this.experiments.update(id, /** 执行「result」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(value) => change(structuredClone(value)));
    if (!result) throw new Error(`Experiment 不存在: ${id}`);
    return result;
  }
  /** 读取「getScorecard」所需数据，并遵守作用域、分页与容量边界。 */
async getScorecard(experimentId: string): Promise<ExperimentScorecard | undefined> {
    return this.scorecards.get(experimentId);
  }
  /** 更新「putScorecard」对应状态，并保持写入顺序、原子性与容量约束。 */
async putScorecard(value: ExperimentScorecard): Promise<void> {
    await this.scorecards.put(structuredClone(value));
  }
  /** 释放或删除「deleteScorecard」对应资源，重复调用仍保持安全。 */
async deleteScorecard(experimentId: string): Promise<void> {
    await this.scorecards.remove(experimentId);
  }
  /** 释放或删除「remove」对应资源，重复调用仍保持安全。 */
async remove(experimentId: string): Promise<void> {
    await this.experiments.remove(experimentId);
    await this.deleteScorecard(experimentId);
  }
}

/** 判断「isExperiment」对应条件，只返回判定结果且不修改输入状态。 */
function isExperiment(value: unknown): value is AnyExperimentRecord {
  if (!record(value)) return false;
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2) return false;
  const configs = value.schemaVersion === 1 ? value.variants : value.tests;
  return typeof value.experimentId === "string" && typeof value.ownerId === "string" &&
    typeof value.status === "string" && Array.isArray(configs) && Array.isArray(value.runs) &&
    typeof value.createdAt === "string" && typeof value.updatedAt === "string";
}
/** 判断「isScorecard」对应条件，只返回判定结果且不修改输入状态。 */
function isScorecard(value: unknown): value is ExperimentScorecard {
  return record(value) && value.schemaVersion === 1 && typeof value.scorecardId === "string" &&
    typeof value.experimentId === "string" && typeof value.status === "string" && Array.isArray(value.variants);
}
/** 更新「record」对应状态，并保持写入顺序、原子性与容量约束。 */
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
