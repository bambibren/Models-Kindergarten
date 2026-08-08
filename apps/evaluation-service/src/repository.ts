import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TurnEvaluationRecord } from "@kindergarten/evaluation-contract";

interface EvaluationFile {
  version: 1;
  records: TurnEvaluationRecord[];
}

/** 独立评测事实存储；原子替换文件，避免中断时留下半份 JSON。 */
export class EvaluationRepository {
  private cache?: TurnEvaluationRecord[];
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string) {}

  async put(record: TurnEvaluationRecord): Promise<void> {
    await this.enqueueWrite(async () => {
      const records = await this.readAll();
      const index = records.findIndex((item) =>
        item.trace.sessionId === record.trace.sessionId &&
        item.trace.turnId === record.trace.turnId
      );
      if (index >= 0) records[index] = structuredClone(record);
      else records.push(structuredClone(record));
      await this.save(records);
    });
  }

  async get(sessionId: string, turnId: string): Promise<TurnEvaluationRecord | undefined> {
    const records = await this.readAll();
    const record = records.find((item) =>
      item.trace.sessionId === sessionId && item.trace.turnId === turnId
    );
    return record ? structuredClone(record) : undefined;
  }

  private async readAll(): Promise<TurnEvaluationRecord[]> {
    if (this.cache) return this.cache;
    try {
      const value = JSON.parse(await readFile(this.file, "utf8")) as EvaluationFile;
      if (value.version !== 1 || !Array.isArray(value.records)) {
        throw new Error("评测数据文件格式无效");
      }
      this.cache = value.records;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      this.cache = [];
    }
    return this.cache;
  }

  private async save(records: TurnEvaluationRecord[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const temp = `${this.file}.tmp`;
    const value: EvaluationFile = { version: 1, records };
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temp, this.file);
  }

  private async enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private get file(): string {
    return join(this.dir, "turn-evaluations.json");
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
