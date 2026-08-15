import { copyFile, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

interface StoreDocument<T> {
  schemaVersion: number;
  records: T[];
}

export interface AtomicJsonStoreOptions<T> {
  file: string;
  schemaVersion: number;
  validate: (value: unknown) => value is T;
}

/** 所有领域 JSON Store 共用的原子写与损坏恢复边界。 */
export class AtomicJsonStore<T> {
  private cache?: T[];
  private queue: Promise<void> = Promise.resolve();
  private loaded = false;

  constructor(private readonly options: AtomicJsonStoreOptions<T>) {}

  async read(): Promise<T[]> {
    if (!this.loaded) await this.load();
    return structuredClone(this.cache ?? []);
  }

  async replace(records: T[]): Promise<void> {
    await this.update(() => records);
  }

  async update<R>(change: (records: T[]) => T[] | { records: T[]; result: R }): Promise<R | undefined> {
    return this.enqueue(async () => {
      const current = await this.read();
      const changed = change(current);
      const records = Array.isArray(changed) ? changed : changed.records;
      const result = Array.isArray(changed) ? undefined : changed.result;
      this.validateRecords(records);
      await this.save(records);
      this.cache = structuredClone(records);
      this.loaded = true;
      return result;
    });
  }

  private async load(): Promise<void> {
    try {
      this.cache = await this.readDocument(this.options.file);
      this.loaded = true;
      return;
    } catch (primaryError) {
      if (isMissing(primaryError)) {
        this.cache = [];
        this.loaded = true;
        return;
      }
      try {
        const backup = await this.readDocument(`${this.options.file}.bak`);
        this.cache = backup;
        this.loaded = true;
        await this.writeDocument(this.options.file, backup, false);
        return;
      } catch (backupError) {
        if (isMissing(backupError)) throw primaryError;
        throw new Error("Store 主文件和备份都不可读，已停止写入", { cause: primaryError });
      }
    }
  }

  private async readDocument(file: string): Promise<T[]> {
    const value = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (!isRecord(value) || value.schemaVersion !== this.options.schemaVersion) {
      throw new Error(`Store schemaVersion 无效，预期 ${this.options.schemaVersion}`);
    }
    if (!Array.isArray(value.records)) throw new Error("Store records 必须是数组");
    this.validateRecords(value.records);
    return structuredClone(value.records);
  }

  private validateRecords(records: unknown[]): asserts records is T[] {
    const invalid = records.findIndex((item) => !this.options.validate(item));
    if (invalid >= 0) throw new Error(`Store record[${invalid}] 格式无效`);
  }

  private async save(records: T[]): Promise<void> {
    await mkdir(dirname(this.options.file), { recursive: true });
    try {
      await copyFile(this.options.file, `${this.options.file}.bak`);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await this.writeDocument(this.options.file, records, true);
  }

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

  private async enqueue<R>(operation: () => Promise<R>): Promise<R> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
