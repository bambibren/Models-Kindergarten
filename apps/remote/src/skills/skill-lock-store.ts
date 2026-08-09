import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SkillInstallRecord } from "./skill-types.js";

interface SkillLockDocument {
  version: 1;
  records: SkillInstallRecord[];
}

export class SkillLockStore {
  constructor(private readonly file: string) {}

  async load(): Promise<SkillInstallRecord[]> {
    try {
      const value = JSON.parse(await readFile(this.file, "utf8")) as SkillLockDocument;
      if (value.version !== 1 || !Array.isArray(value.records)) throw new Error("Skill lock 格式无效");
      return structuredClone(value.records);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  async put(record: SkillInstallRecord): Promise<void> {
    const records = await this.load();
    if (records.some((item) => item.name === record.name)) {
      throw new Error(`Skill 已存在于 lock: ${record.name}`);
    }
    records.push(structuredClone(record));
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    await writeFile(temp, `${JSON.stringify({ version: 1, records }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temp, this.file);
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
