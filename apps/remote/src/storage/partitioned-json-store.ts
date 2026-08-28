import { createHash } from "node:crypto";
import { copyFile, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

interface LegacyStoreDocument<T> {
  schemaVersion: number;
  records: T[];
}

interface PartitionIndex {
  schemaVersion: 1;
  recordSchemaVersion: number;
  ids: string[];
}

interface PartitionRecord<T> {
  schemaVersion: 1;
  id: string;
  value: T;
}

/** 描述「PartitionedJsonStoreOptions」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface PartitionedJsonStoreOptions<T> {
  /** 旧版聚合 JSON 文件；其文件名同时用于推导新分片目录。 */
  legacyFile: string;
  recordSchemaVersion: number;
  legacySchemaVersions?: number[];
  idOf: (value: T) => string;
  validate: (value: unknown) => value is T;
}

/**
 * 将会持续增长的领域记录拆成“一条记录一个文件”。
 *
 * 小型 index 只保存 ID；普通 get/update 不再解析全部领域对象。首次访问时先写完
 * 所有分片，最后原子切换 index，因此中途失败不会让半套迁移成为持久化真相。
 */
export class PartitionedJsonStore<T> {
  private readonly root: string;
  private readonly recordsDirectory: string;
  private readonly indexFile: string;
  private queue: Promise<void> = Promise.resolve();

  /** 只推导稳定分片路径；构造阶段不读取全量数据，也不启动后台任务。 */
constructor(private readonly options: PartitionedJsonStoreOptions<T>) {
    const extension = extname(options.legacyFile);
    const stem = basename(options.legacyFile, extension);
    this.root = join(dirname(options.legacyFile), stem);
    this.recordsDirectory = join(this.root, "records");
    this.indexFile = join(this.root, "index.json");
  }

  /** 显式列表操作才逐条读取全部分片。 */
  async read(): Promise<T[]> {
    return this.enqueue(/** 读取「read」所需数据，并遵守作用域、分页与容量边界。 */
async () => {
      const index = await this.ensureIndex();
      const values: T[] = [];
      for (const id of index.ids) values.push(await this.readRecord(id));
      return values;
    });
  }

  /** 按稳定 ID 直接命中一个分片。 */
  async get(id: string): Promise<T | undefined> {
    return this.enqueue(/** 读取「get」所需数据，并遵守作用域、分页与容量边界。 */
async () => {
      const index = await this.ensureIndex();
      if (!index.ids.includes(id)) return undefined;
      return this.readRecord(id);
    });
  }

  /** 为需要二级条件的少量调用提供提前停止的顺序查找。 */
  async find(predicate: (value: T) => boolean): Promise<T | undefined> {
    return this.enqueue(/** 读取「find」所需数据，并遵守作用域、分页与容量边界。 */
async () => {
      const index = await this.ensureIndex();
      for (const id of index.ids) {
        const value = await this.readRecord(id);
        if (predicate(value)) return value;
      }
      return undefined;
    });
  }

  /** 插入新分片，并可在同一串行临界区检查跨记录冲突。 */
  async insert(value: T, conflict?: (existing: T) => Error | undefined): Promise<void> {
    await this.enqueue(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
async () => {
      this.validateValue(value);
      const id = this.readId(value);
      const index = await this.ensureIndex();
      if (index.ids.includes(id)) throw new Error(`分片记录已存在: ${id}`);
      if (conflict) {
        for (const existingId of index.ids) {
          const error = conflict(await this.readRecord(existingId));
          if (error) throw error;
        }
      }
      await this.writeRecord(id, value);
      await this.writeIndex({ ...index, ids: [...index.ids, id] });
    });
  }

  /** 新值覆盖目标分片；不存在时追加到 index。 */
  async put(value: T): Promise<void> {
    await this.enqueue(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
async () => {
      this.validateValue(value);
      const id = this.readId(value);
      const index = await this.ensureIndex();
      await this.writeRecord(id, value);
      if (!index.ids.includes(id)) await this.writeIndex({ ...index, ids: [...index.ids, id] });
    });
  }

  /** 只读取并更新目标 ID，不物化其他领域记录。 */
  async update(id: string, change: (value: T) => T): Promise<T | undefined> {
    return this.enqueue(/** 更新「update」对应状态，并保持写入顺序、原子性与容量约束。 */
async () => {
      const index = await this.ensureIndex();
      if (!index.ids.includes(id)) return undefined;
      const next = change(await this.readRecord(id));
      this.validateValue(next);
      if (this.readId(next) !== id) throw new Error("分片更新不能改变记录 ID");
      await this.writeRecord(id, next);
      return structuredClone(next);
    });
  }

  /** 先从 index 隐藏目标，再删除已经不可达的分片文件。 */
  async remove(id: string): Promise<void> {
    await this.enqueue(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
async () => {
      const index = await this.ensureIndex();
      if (!index.ids.includes(id)) return;
      await this.writeIndex({ ...index, ids: index.ids.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(candidate) => candidate !== id) });
      await removeIfPresent(this.recordFile(id));
      await removeIfPresent(`${this.recordFile(id)}.bak`);
    });
  }

  /** 所有公开操作共享队列，避免同一进程内的 index 更新互相覆盖。 */
  private async enqueue<R>(operation: () => Promise<R>): Promise<R> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => undefined, /** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => undefined);
    return result;
  }

  /** 读取现有 index；不存在时执行一次旧聚合文件迁移。 */
  private async ensureIndex(): Promise<PartitionIndex> {
    try {
      return await this.readIndex(this.indexFile);
    } catch (error) {
      if (!isMissing(error)) {
        try {
          const backup = await this.readIndex(`${this.indexFile}.bak`);
          await this.writeJsonAtomically(this.indexFile, backup, false);
          return backup;
        } catch (backupError) {
          if (!isMissing(backupError)) throw new Error("分片 Store 的 index 与备份都不可读，已停止写入", { cause: error });
          throw error;
        }
      }
    }
    return this.migrateLegacyStore();
  }

  /** 分片先落盘，index 最后落盘；index 是新布局是否生效的唯一切换点。 */
  private async migrateLegacyStore(): Promise<PartitionIndex> {
    let legacy: LegacyStoreDocument<T> | undefined;
    try {
      legacy = await this.readLegacyDocument(this.options.legacyFile);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const value of legacy?.records ?? []) {
      const id = this.readId(value);
      if (seen.has(id)) throw new Error(`旧 Store 存在重复 ID: ${id}`);
      seen.add(id);
      ids.push(id);
      await this.writeRecord(id, value);
    }
    const index: PartitionIndex = {
      schemaVersion: 1,
      recordSchemaVersion: this.options.recordSchemaVersion,
      ids,
    };
    await this.writeIndex(index);
    if (legacy) {
      const backup = `${this.options.legacyFile}.v${legacy.schemaVersion}.bak`;
      await copyFile(this.options.legacyFile, backup);
      await removeIfPresent(this.options.legacyFile);
    }
    return index;
  }

  /** 校验旧聚合文档，拒绝静默跳过损坏记录。 */
  private async readLegacyDocument(file: string): Promise<LegacyStoreDocument<T>> {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    const accepted = [this.options.recordSchemaVersion, ...(this.options.legacySchemaVersions ?? [])];
    if (!isRecord(parsed) || typeof parsed.schemaVersion !== "number" || !accepted.includes(parsed.schemaVersion)) {
      throw new Error(`旧 Store schemaVersion 无效，预期 ${accepted.join("/")}`);
    }
    if (!Array.isArray(parsed.records)) throw new Error("旧 Store records 必须是数组");
    for (const value of parsed.records) this.validateValue(value);
    return { schemaVersion: parsed.schemaVersion, records: structuredClone(parsed.records as T[]) };
  }

  /** index 只包含版本和稳定 ID，不能承载领域正文。 */
  private async readIndex(file: string): Promise<PartitionIndex> {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || parsed.recordSchemaVersion !== this.options.recordSchemaVersion ||
      !Array.isArray(parsed.ids) || !parsed.ids.every(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(id) => typeof id === "string" && id.length > 0) ||
      new Set(parsed.ids).size !== parsed.ids.length) {
      throw new Error("分片 Store index 格式无效");
    }
    return structuredClone(parsed as unknown as PartitionIndex);
  }

  /** 单条记录损坏时尝试同 ID 备份；两者都损坏则停止写入。 */
  private async readRecord(id: string): Promise<T> {
    const file = this.recordFile(id);
    try {
      return await this.readRecordFile(file, id);
    } catch (error) {
      try {
        const backup = await this.readRecordFile(`${file}.bak`, id);
        await this.writeJsonAtomically(file, { schemaVersion: 1, id, value: backup } satisfies PartitionRecord<T>, false);
        return backup;
      } catch (backupError) {
        if (isMissing(backupError)) throw error;
        throw new Error(`分片记录与备份都不可读: ${id}`, { cause: error });
      }
    }
  }

  /** 读取时同时校验文件内 ID 与领域对象 ID。 */
  private async readRecordFile(file: string, expectedId: string): Promise<T> {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || parsed.id !== expectedId || !("value" in parsed)) {
      throw new Error(`分片记录格式无效: ${expectedId}`);
    }
    this.validateValue(parsed.value);
    if (this.readId(parsed.value) !== expectedId) throw new Error(`分片领域 ID 不一致: ${expectedId}`);
    return structuredClone(parsed.value);
  }

  /** 更新现有记录前保留单条备份，不复制其他分片。 */
  private async writeRecord(id: string, value: T): Promise<void> {
    const file = this.recordFile(id);
    await mkdir(this.recordsDirectory, { recursive: true });
    try {
      await copyFile(file, `${file}.bak`);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await this.writeJsonAtomically(file, { schemaVersion: 1, id, value: structuredClone(value) } satisfies PartitionRecord<T>, true);
  }

  /** index 写入前保留上一版本，用于主 index 损坏恢复。 */
  private async writeIndex(index: PartitionIndex): Promise<void> {
    await mkdir(this.root, { recursive: true });
    try {
      await copyFile(this.indexFile, `${this.indexFile}.bak`);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await this.writeJsonAtomically(this.indexFile, index, true);
  }

  /** 临时文件 fsync 后再 rename，避免进程中断留下半截 JSON。 */
  private async writeJsonAtomically(file: string, value: unknown, syncDirectory: boolean): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    const handle = await open(temp, "w", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
    if (syncDirectory) {
      const directory = await open(dirname(file), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  }

  /** ID 经哈希后用于文件名，领域 ID 从不直接参与路径拼接。 */
  private recordFile(id: string): string {
    const digest = createHash("sha256").update(id).digest("hex");
    return join(this.recordsDirectory, `${digest}.json`);
  }

  /** 统一校验领域值，避免无效数据进入任一分片。 */
  private validateValue(value: unknown): asserts value is T {
    if (!this.options.validate(value)) throw new Error("分片 Store record 格式无效");
  }

  /** 稳定 ID 必须非空。 */
  private readId(value: T): string {
    const id = this.options.idOf(value);
    if (!id) throw new Error("分片 Store record ID 不能为空");
    return id;
  }
}

/** 删除已迁移或已从 index 隐藏的文件；不存在视为成功。 */
async function removeIfPresent(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

/** 判断文件系统错误是否为目标不存在。 */
function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** 判断 JSON 结果是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
