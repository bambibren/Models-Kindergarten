import { copyFile, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

interface StoreDocument<T> {
  schemaVersion: number;
  records: T[];
}

/** 描述「AtomicJsonStoreOptions」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface AtomicJsonStoreOptions<T> {
  file: string;
  schemaVersion: number;
  legacySchemaVersions?: number[];
  validate: (value: unknown) => value is T;
}

/** 所有领域 JSON Store 共用的原子写与损坏恢复边界。 */
export class AtomicJsonStore<T> {
  private queue: Promise<void> = Promise.resolve();

  /** 初始化「AtomicJsonStore」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(private readonly options: AtomicJsonStoreOptions<T>) {}

  /** 读取「read」所需数据，并遵守作用域、分页与容量边界。 */
async read(): Promise<T[]> {
    return structuredClone(await this.load());
  }

  /** 执行「replace」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async replace(records: T[]): Promise<void> {
    await this.update(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
() => records);
  }

  /** 更新「update」对应状态，并保持写入顺序、原子性与容量约束。 */
async update<R>(change: (records: T[]) => T[] | { records: T[]; result: R }): Promise<R | undefined> {
    return this.enqueue(/** 更新「update」对应状态，并保持写入顺序、原子性与容量约束。 */
async () => {
      const current = await this.read();
      const changed = change(current);
      const records = Array.isArray(changed) ? changed : changed.records;
      const result = Array.isArray(changed) ? undefined : changed.result;
      this.validateRecords(records);
      await this.save(records);
      return result;
    });
  }

  /**
   * Store 文件是持久化真相，不把完整 records 永久挂在进程堆上。
   * 当前仍在单次操作中读取完整文件；更大数据集应迁移到按记录分片的 Store。
   */
  private async load(): Promise<T[]> {
    try {
      return await this.readDocument(this.options.file);
    } catch (primaryError) {
      if (isMissing(primaryError)) return [];
      try {
        const backup = await this.readDocument(`${this.options.file}.bak`);
        await this.writeDocument(this.options.file, backup, false);
        return backup;
      } catch (backupError) {
        if (isMissing(backupError)) throw primaryError;
        throw new Error("Store 主文件和备份都不可读，已停止写入", { cause: primaryError });
      }
    }
  }

  /** 读取「readDocument」所需数据，并遵守作用域、分页与容量边界。 */
private async readDocument(file: string): Promise<T[]> {
    const value = JSON.parse(await readFile(file, "utf8")) as unknown;
    const acceptedVersions = [this.options.schemaVersion, ...(this.options.legacySchemaVersions ?? [])];
    if (!isRecord(value) || typeof value.schemaVersion !== "number" || !acceptedVersions.includes(value.schemaVersion)) {
      throw new Error(`Store schemaVersion 无效，预期 ${this.options.schemaVersion}`);
    }
    if (!Array.isArray(value.records)) throw new Error("Store records 必须是数组");
    this.validateRecords(value.records);
    return structuredClone(value.records);
  }

  /** 校验并规范化「validateRecords」输入，非法数据直接返回明确错误。 */
private validateRecords(records: unknown[]): asserts records is T[] {
    const invalid = records.findIndex(/** 执行「invalid」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(item) => !this.options.validate(item));
    if (invalid >= 0) throw new Error(`Store record[${invalid}] 格式无效`);
  }

  /** 更新「save」对应状态，并保持写入顺序、原子性与容量约束。 */
private async save(records: T[]): Promise<void> {
    await mkdir(dirname(this.options.file), { recursive: true });
    try {
      await copyFile(this.options.file, `${this.options.file}.bak`);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await this.writeDocument(this.options.file, records, true);
  }

  /** 更新「writeDocument」对应状态，并保持写入顺序、原子性与容量约束。 */
private async writeDocument(file: string, records: T[], syncDirectory: boolean): Promise<void> {
    const temp = `${file}.tmp`;
    const document: StoreDocument<T> = { schemaVersion: this.options.schemaVersion, records };
    const handle = await open(temp, "w", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
    if (syncDirectory) {
      const dir = await open(dirname(file), "r");
      try { await dir.sync(); } finally { await dir.close(); }
    }
  }

  /** 串行化同一文件的原子替换，并在 settle 后把队列链收敛为不携带结果的 Promise。 */
private async enqueue<R>(operation: () => Promise<R>): Promise<R> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => undefined, /** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => undefined);
    return result;
  }
}

/** 判断「isRecord」对应条件，只返回判定结果且不修改输入状态。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 判断「isMissing」对应条件，只返回判定结果且不修改输入状态。 */
function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
