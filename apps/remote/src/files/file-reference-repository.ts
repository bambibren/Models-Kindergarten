import type { FileReference } from "@kindergarten/contracts";
import { PartitionedJsonStore } from "../storage/partitioned-json-store.js";

/** 描述「FileReferenceRepository」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export class FileReferenceRepository {
  private readonly store: PartitionedJsonStore<FileReference>;

  /** 初始化「FileReferenceRepository」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(file: string) {
    this.store = new PartitionedJsonStore({
      legacyFile: file,
      recordSchemaVersion: 1,
      idOf: /** 执行「idOf」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(value) => value.fileReferenceId,
      validate: isFileReference,
    });
  }

  /** 读取「list」所需数据，并遵守作用域、分页与容量边界。 */
list(): Promise<FileReference[]> { return this.store.read(); }

  /** 读取「get」所需数据，并遵守作用域、分页与容量边界。 */
async get(id: string): Promise<FileReference | undefined> {
    return this.store.get(id);
  }

  /** 更新「insert」对应状态，并保持写入顺序、原子性与容量约束。 */
async insert(value: FileReference): Promise<void> {
    await this.store.insert(structuredClone(value));
  }
}

/** 判断「isFileReference」对应条件，只返回判定结果且不修改输入状态。 */
function isFileReference(value: unknown): value is FileReference {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Partial<FileReference>;
  return item.schemaVersion === 1 && typeof item.fileReferenceId === "string" && typeof item.ownerId === "string" &&
    typeof item.sessionId === "string" && typeof item.turnId === "string" && typeof item.relativePath === "string" &&
    typeof item.byteLength === "number" && typeof item.sha256 === "string" && typeof item.createdAt === "string";
}
