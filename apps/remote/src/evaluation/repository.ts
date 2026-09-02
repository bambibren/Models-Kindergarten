import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ScoreResultRecord, ScoreResultSource, TurnEffectScoreRecord, TurnEvaluationRecord } from "@kindergarten/evaluation-contract";
import { PartitionedJsonStore } from "../storage/partitioned-json-store.js";
import { normalizeTurnTrace } from "./trace-migration.js";

interface EvaluationIndexEntry {
  sessionId: string;
  turnId: string;
  file: string;
  createdAt: string;
}

interface EvaluationIndex {
  version: 2;
  records: EvaluationIndexEntry[];
}

interface LegacyEvaluationFile {
  version: 1;
  records: Array<{
    schemaVersion: number;
    trace: unknown;
    result: TurnEvaluationRecord["result"];
    createdAt: string;
  }>;
}

/**
 * Evaluation 事实存储：一 Turn 一文件，索引只保存定位元数据。
 *
 * `get` 通过稳定哈希直接读取单条记录，不再解析或克隆全部历史；旧 V1 单数组只在首次访问时迁移一次。
 */
export class EvaluationRepository {
  private writeQueue: Promise<void> = Promise.resolve();
  private migration?: Promise<void>;
  private initialized = false;
  private readonly scoreResults: PartitionedJsonStore<ScoreResultRecord>;

  /** 初始化「EvaluationRepository」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(private readonly dir: string) {
    this.scoreResults = new PartitionedJsonStore({
      legacyFile: join(dir, "score-results.json"),
      recordSchemaVersion: 1,
      idOf: /** 原子评分以稳定 scoreResultId 分片，来源页面不参与文件路径。 */
      (value) => value.scoreResultId,
      validate: isScoreResult,
    });
  }

  /** 启动监听前验证数据目录可创建，并完成可能存在的旧格式迁移。 */
  async initialize(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await this.ensureMigrated();
    await this.scoreResults.read();
    this.initialized = true;
  }

  /** 只报告启动初始化是否完成，不以是否已有评测记录作为就绪条件。 */
  get ready(): boolean { return this.initialized; }

  /** 更新「put」对应状态，并保持写入顺序、原子性与容量约束。 */
async put(record: TurnEvaluationRecord): Promise<void> {
    await this.enqueueWrite(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
async () => {
      await this.ensureMigrated();
      await this.writeRecord(record);
      const index = await this.readIndex();
      const entry = indexEntry(record);
      const records = index.records.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) =>
        item.sessionId !== entry.sessionId || item.turnId !== entry.turnId);
      records.push(entry);
      await this.saveIndex({ version: 2, records });
    });
  }

  /** 读取「get」所需数据，并遵守作用域、分页与容量边界。 */
async get(sessionId: string, turnId: string): Promise<TurnEvaluationRecord | undefined> {
    await this.ensureMigrated();
    try {
      const value = JSON.parse(
        await readFile(this.recordPath(sessionId, turnId), "utf8"),
      ) as TurnEvaluationRecord;
      if (value.schemaVersion !== 2 || value.trace.sessionId !== sessionId || value.trace.turnId !== turnId) {
        throw new Error("评测记录文件格式或身份不匹配");
      }
      return structuredClone(value);
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  }

  /** 读取用户显式保存的单 Turn 人工效果打分。 */
  async getEffectScore(sessionId: string, turnId: string): Promise<TurnEffectScoreRecord | undefined> {
    await this.ensureMigrated();
    try {
      const value = JSON.parse(await readFile(this.effectScorePath(sessionId, turnId), "utf8")) as TurnEffectScoreRecord;
      if (value.schemaVersion !== 1 || value.sessionId !== sessionId || value.turnId !== turnId) {
        throw new Error("效果打分文件格式或身份不匹配");
      }
      return structuredClone(value);
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  }

  /** 单 Turn 打分独立分片，避免修改 Runtime 生成的不可变评测事实。 */
  async putEffectScore(record: TurnEffectScoreRecord): Promise<void> {
    await this.enqueueWrite(/** 人工分沿用评测仓库的串行原子写队列，避免同一 Turn 覆盖竞争。 */
    async () => {
      await this.ensureMigrated();
      await mkdir(this.effectScoresDir, { recursive: true });
      await atomicWrite(this.effectScorePath(record.sessionId, record.turnId), `${JSON.stringify(record, null, 2)}\n`);
    });
  }

  /** 启动迁移只遍历人工效果分目录；每条仍执行与点查相同的身份校验。 */
  async listEffectScores(): Promise<TurnEffectScoreRecord[]> {
    await this.ensureMigrated();
    let files: string[];
    try { files = await readdir(this.effectScoresDir); }
    catch (error) { if (isMissingFile(error)) return []; throw error; }
    const records: TurnEffectScoreRecord[] = [];
    for (const file of files.toSorted()) {
      if (!file.endsWith(".json")) continue;
      const value = JSON.parse(await readFile(join(this.effectScoresDir, file), "utf8")) as TurnEffectScoreRecord;
      if (value.schemaVersion !== 1 || typeof value.sessionId !== "string" || typeof value.turnId !== "string") {
        throw new Error(`效果打分文件格式无效: ${file}`);
      }
      records.push(structuredClone(value));
    }
    return records;
  }

  /** 按稳定 ID 读取一条与来源页面解耦的原子评分。 */
  async getScoreResult(scoreResultId: string): Promise<ScoreResultRecord | undefined> {
    return this.scoreResults.get(scoreResultId);
  }

  /** 原子评分的同一来源重复保存为覆盖更新，不产生重复历史。 */
  async putScoreResult(record: ScoreResultRecord): Promise<void> {
    await this.scoreResults.put(structuredClone(record));
  }

  /** 聚合查询显式读取评分分片，调用方继续按账号和模型收紧范围。 */
  async listScoreResults(): Promise<ScoreResultRecord[]> {
    return this.scoreResults.read();
  }

  /** 来源被删除时同步移除其全部原子评分，避免排行残留悬空链接。 */
  async removeScoreResultsBySource(source: Pick<ScoreResultSource, "kind"> & Partial<ScoreResultSource>): Promise<void> {
    const records = await this.scoreResults.read();
    for (const record of records) {
      if (sameSourceScope(record.source, source)) await this.scoreResults.remove(record.scoreResultId);
    }
  }

  /** 共享同一个迁移 Promise，避免首个 GET 与 POST 并发时重复改写旧文件。 */
  private ensureMigrated(): Promise<void> {
    this.migration ??= this.migrateLegacy();
    return this.migration;
  }

  /** 将旧聚合数组逐条写成 Turn 分片，最后切换索引并保留可恢复备份。 */
private async migrateLegacy(): Promise<void> {
    let legacy: LegacyEvaluationFile;
    try {
      legacy = JSON.parse(await readFile(this.legacyFile, "utf8")) as LegacyEvaluationFile;
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }
    if (legacy.version !== 1 || !Array.isArray(legacy.records)) {
      throw new Error("旧评测数据文件格式无效");
    }
    const entries: EvaluationIndexEntry[] = [];
    for (const old of legacy.records) {
      const trace = normalizeTurnTrace(old.trace);
      const record: TurnEvaluationRecord = {
        schemaVersion: 2,
        trace,
        result: structuredClone(old.result),
        createdAt: old.createdAt,
      };
      await this.writeRecord(record);
      entries.push(indexEntry(record));
    }
    await this.saveIndex({ version: 2, records: dedupeIndex(entries) });
    await rename(this.legacyFile, `${this.legacyFile}.v1.bak`);
  }

  /** 读取「readIndex」所需数据，并遵守作用域、分页与容量边界。 */
private async readIndex(): Promise<EvaluationIndex> {
    try {
      const value = JSON.parse(await readFile(this.indexFile, "utf8")) as EvaluationIndex;
      if (value.version !== 2 || !Array.isArray(value.records)) {
        throw new Error("评测索引格式无效");
      }
      return value;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      return { version: 2, records: [] };
    }
  }

  /** 更新「writeRecord」对应状态，并保持写入顺序、原子性与容量约束。 */
private async writeRecord(record: TurnEvaluationRecord): Promise<void> {
    await mkdir(this.recordsDir, { recursive: true });
    const target = this.recordPath(record.trace.sessionId, record.trace.turnId);
    await atomicWrite(target, `${JSON.stringify(record, null, 2)}\n`);
  }

  /** 更新「saveIndex」对应状态，并保持写入顺序、原子性与容量约束。 */
private async saveIndex(index: EvaluationIndex): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await atomicWrite(this.indexFile, `${JSON.stringify(index, null, 2)}\n`);
  }

  /** 串行更新记录与索引；settle 后丢弃闭包结果，避免队列长期引用评测文档。 */
private async enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => undefined, /** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => undefined);
    return result;
  }

  /** 更新「recordPath」对应状态，并保持写入顺序、原子性与容量约束。 */
private recordPath(sessionId: string, turnId: string): string {
    return join(this.recordsDir, `${recordKey(sessionId, turnId)}.json`);
  }

  /** 使用哈希后的 Session/Turn 组合键，禁止原始标识参与文件路径。 */
  private effectScorePath(sessionId: string, turnId: string): string {
    return join(this.effectScoresDir, `${recordKey(sessionId, turnId)}.json`);
  }

  /** 人工效果分与 Runtime 事实分目录保存，避免改变已生成的执行评测。 */
  private get effectScoresDir(): string {
    return join(this.dir, "turn-effect-scores");
  }

  /** 更新「recordsDir」对应状态，并保持写入顺序、原子性与容量约束。 */
private get recordsDir(): string {
    return join(this.dir, "turn-evaluations");
  }

  /** 根据受控标识构造「indexFile」路径；调用方仍须执行归属与目录边界校验。 */
private get indexFile(): string {
    return join(this.dir, "turn-evaluations.index.json");
  }

  /** 根据受控标识构造「legacyFile」路径；调用方仍须执行归属与目录边界校验。 */
private get legacyFile(): string {
    return join(this.dir, "turn-evaluations.json");
  }
}

/** 固定临时文件只在 Repository 串行写队列内使用，rename 后不会暴露半份 JSON。 */
async function atomicWrite(file: string, content: string): Promise<void> {
  const temp = `${file}.tmp`;
  await writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
  await rename(temp, file);
}

/** 文件名不暴露用户提供的 Session/Turn ID，也不受路径字符影响。 */
function recordKey(sessionId: string, turnId: string): string {
  return createHash("sha256").update(sessionId).update("\0").update(turnId).digest("hex");
}

/** 从完整记录生成小索引项，查询正文不依赖该数组。 */
function indexEntry(record: TurnEvaluationRecord): EvaluationIndexEntry {
  return {
    sessionId: record.trace.sessionId,
    turnId: record.trace.turnId,
    file: `${recordKey(record.trace.sessionId, record.trace.turnId)}.json`,
    createdAt: record.createdAt,
  };
}

/** 迁移时后出现的同一 Turn 覆盖旧项，符合既有 put 的幂等语义。 */
function dedupeIndex(entries: EvaluationIndexEntry[]): EvaluationIndexEntry[] {
  const byTurn = new Map<string, EvaluationIndexEntry>();
  for (const entry of entries) byTurn.set(`${entry.sessionId}\0${entry.turnId}`, entry);
  return [...byTurn.values()];
}

/** 只把文件不存在解释为空记录，损坏或权限错误必须继续上抛。 */
function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** 分片读取时验证排行依赖的身份、分数和配置指纹，损坏记录不得静默参与聚合。 */
function isScoreResult(value: unknown): value is ScoreResultRecord {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.scoreResultId !== "string" ||
    typeof value.ownerId !== "string" || typeof value.modelStudentId !== "string" ||
    typeof value.sourceTitle !== "string" || !isRecord(value.source) || !isRecord(value.agentConfiguration) ||
    !isRecord(value.dimensionScores) || (value.status !== "draft" && value.status !== "complete") ||
    typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") return false;
  if (value.source.kind !== "context_experiment" && value.source.kind !== "turn_effect") return false;
  if (value.source.kind === "context_experiment" &&
    (![value.source.experimentId, value.source.testId, value.source.scorecardId].every((item) => typeof item === "string"))) return false;
  if (value.source.kind === "turn_effect" &&
    (![value.source.sessionId, value.source.turnId].every((item) => typeof item === "string"))) return false;
  if (!isAgentConfiguration(value.agentConfiguration)) return false;
  if (!validScore(value.dimensionScores.execution)) return false;
  for (const key of ["understanding", "planning", "output"] as const) {
    if (value.dimensionScores[key] !== undefined && !validScore(value.dimensionScores[key])) return false;
  }
  return value.status !== "complete" || validScore(value.totalScore);
}

/** 校验配置详情页会直接遍历的集合，损坏记录不能进入页面聚合。 */
function isAgentConfiguration(value: Record<string, unknown>): boolean {
  if (![value.configurationHash, value.agentSnapshotHash, value.agentId, value.agentName, value.systemPrompt]
    .every((item) => typeof item === "string")) return false;
  if (!Array.isArray(value.builtinTools) || !Array.isArray(value.builtinSkills) || !Array.isArray(value.skills) || !Array.isArray(value.mcps)) return false;
  if (!value.builtinTools.every((item) => isRecord(item) && typeof item.toolId === "string" && typeof item.enabled === "boolean" && validPermission(item.permission))) return false;
  if (!value.builtinSkills.every((item) => isRecord(item) && typeof item.skillId === "string" && typeof item.enabled === "boolean")) return false;
  if (!value.skills.every((item) => isRecord(item) && typeof item.skillInstallationId === "string" && typeof item.enabled === "boolean")) return false;
  if (!value.mcps.every((item) => isRecord(item) && typeof item.mcpInstallationId === "string" && typeof item.enabled === "boolean" &&
    Array.isArray(item.tools) && item.tools.every((tool) => isRecord(tool) && typeof tool.remoteName === "string" && typeof tool.enabled === "boolean" && validPermission(tool.permission)) &&
    Array.isArray(item.resources) && item.resources.every((resource) => isRecord(resource) && typeof resource.uri === "string" && typeof resource.enabled === "boolean" && typeof resource.preload === "boolean"))) return false;
  return isRecord(value.historyPolicy) && (value.historyPolicy.mode === "none" ||
    (value.historyPolicy.mode === "recent_turns" && typeof value.historyPolicy.maxTurns === "number")) &&
    isRecord(value.memoryPolicy) && value.memoryPolicy.mode === "off" && isRecord(value.reasoning) &&
    typeof value.reasoning.resolvedProfile === "string" && isRecord(value.reasoning.native);
}

function validPermission(value: unknown): boolean { return value === "allow" || value === "ask" || value === "deny"; }

/** 原子评分只接受有限 0～100 数值，避免 NaN 破坏排序。 */
function validScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

/** 删除范围只比较来源类型及其父级事实 ID，不把同一实验的其他 lane 误删。 */
function sameSourceScope(source: ScoreResultSource, scope: Pick<ScoreResultSource, "kind"> & Partial<ScoreResultSource>): boolean {
  if (source.kind !== scope.kind) return false;
  if (source.kind === "context_experiment") {
    return "experimentId" in scope && source.experimentId === scope.experimentId &&
      (!("testId" in scope) || scope.testId === undefined || source.testId === scope.testId);
  }
  return "sessionId" in scope && source.sessionId === scope.sessionId &&
    (!("turnId" in scope) || scope.turnId === undefined || source.turnId === scope.turnId);
}

/** 判断 JSON 外层对象形状，不接受数组或 null。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
