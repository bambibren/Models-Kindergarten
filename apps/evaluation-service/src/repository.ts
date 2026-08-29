import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TurnEvaluationRecord } from "@kindergarten/evaluation-contract";
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
 * 独立评测事实存储：一 Turn 一文件，索引只保存定位元数据。
 *
 * `get` 通过稳定哈希直接读取单条记录，不再解析或克隆全部历史；旧 V1 单数组只在首次访问时迁移一次。
 */
export class EvaluationRepository {
  private writeQueue: Promise<void> = Promise.resolve();
  private migration?: Promise<void>;
  private initialized = false;

  /** 初始化「EvaluationRepository」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(private readonly dir: string) {}

  /** 启动监听前验证数据目录可创建，并完成可能存在的旧格式迁移。 */
  async initialize(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await this.ensureMigrated();
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
