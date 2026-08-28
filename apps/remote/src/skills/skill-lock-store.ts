import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SkillInstallRecord } from "./skill-types.js";

interface SkillLockDocument {
  version: 1;
  records: SkillInstallRecord[];
}

/** 描述「SkillLockStore」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export class SkillLockStore {
  /** 初始化「SkillLockStore」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(private readonly file: string) {}

  /** 读取「load」所需数据，并遵守作用域、分页与容量边界。 */
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

  /** 更新「put」对应状态，并保持写入顺序、原子性与容量约束。 */
async put(record: SkillInstallRecord): Promise<void> {
    const records = await this.load();
    if (records.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.name === record.name)) {
      throw new Error(`Skill 已存在于 lock: ${record.name}`);
    }
    records.push(structuredClone(record));
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    await writeFile(temp, `${JSON.stringify({ version: 1, records }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temp, this.file);
  }

  /** 执行「upsert」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async upsert(record: SkillInstallRecord): Promise<void> {
    const records = await this.load();
    const next = records.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.name !== record.name);
    next.push(structuredClone(record));
    await this.write(next);
  }

  /** 释放或删除「remove」对应资源，重复调用仍保持安全。 */
async remove(name: string): Promise<void> {
    await this.write((await this.load()).filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.name !== name));
  }

  /** 更新「write」对应状态，并保持写入顺序、原子性与容量约束。 */
private async write(records: SkillInstallRecord[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    await writeFile(temp, `${JSON.stringify({ version: 1, records }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temp, this.file);
  }
}

/** 判断「isMissing」对应条件，只返回判定结果且不修改输入状态。 */
function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
