import type { ArtifactRecord, ArtifactRevision, ArtifactState } from "@kindergarten/contracts";
import { PartitionedJsonStore } from "../storage/partitioned-json-store.js";

/** 描述「ArtifactRepository」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export class ArtifactRepository {
  private readonly store: PartitionedJsonStore<ArtifactRecord>;

  /** 初始化「ArtifactRepository」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(file: string) {
    this.store = new PartitionedJsonStore({
      legacyFile: file,
      recordSchemaVersion: 1,
      idOf: /** 执行「idOf」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(value) => value.artifactId,
      validate: isArtifactRecord,
    });
  }

  /** 读取「list」所需数据，并遵守作用域、分页与容量边界。 */
async list(): Promise<ArtifactRecord[]> {
    return (await this.store.read()).map(normalizeArtifactRecord);
  }

  /** 读取「get」所需数据，并遵守作用域、分页与容量边界。 */
async get(id: string): Promise<ArtifactRecord | undefined> {
    const value = await this.store.get(id);
    return value ? normalizeArtifactRecord(value) : undefined;
  }

  /** 执行「byOperation」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async byOperation(ownerId: string, operationId: string): Promise<ArtifactRecord | undefined> {
    const value = await this.store.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) =>
      item.ownerId === ownerId && (item.operationId === operationId ||
        item.revisions?.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(revision) => revision.operationId === operationId) === true));
    return value ? normalizeArtifactRecord(value) : undefined;
  }

  /** 更新「insert」对应状态，并保持写入顺序、原子性与容量约束。 */
async insert(value: ArtifactRecord): Promise<void> {
    await this.store.insert(structuredClone(value), /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(item) =>
      item.ownerId === value.ownerId && item.operationId === value.operationId
        ? new Error("Artifact operationId 已存在")
        : undefined);
  }

  /** 执行「replaceCurrent」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async replaceCurrent(
    id: string,
    ownerId: string,
    revision: ArtifactRevision,
    displayName: string,
    maxRetainedRevisions: number,
  ): Promise<ArtifactRecord | undefined> {
    return this.store.update(id, /** 执行「then」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(stored) => {
      if (stored.ownerId !== ownerId) return stored;
      const current = normalizeArtifactRecord(stored);
      const revisions = [...current.revisions!, structuredClone(revision)].slice(-maxRetainedRevisions);
      const next: ArtifactRecord = {
        ...current,
        displayName,
        sourceSessionId: revision.sourceSessionId,
        sourceTurnId: revision.sourceTurnId,
        primary: structuredClone(revision.primary),
        operationId: revision.operationId,
        updatedAt: revision.createdAt,
        revisions,
      };
      if (revision.manifest) next.manifest = structuredClone(revision.manifest);
      else delete next.manifest;
      return next;
    }).then(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
(result) => result?.ownerId === ownerId ? normalizeArtifactRecord(result) : undefined);
  }

  /** 更新「setState」对应状态，并保持写入顺序、原子性与容量约束。 */
async setState(id: string, ownerId: string, state: ArtifactState): Promise<ArtifactRecord | undefined> {
    const result = await this.store.update(id, /** 执行「result」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(current) => current.ownerId === ownerId
      ? { ...current, state, updatedAt: new Date().toISOString() } satisfies ArtifactRecord
      : current);
    return result?.ownerId === ownerId ? result : undefined;
  }
}

/** 校验并规范化「normalizeArtifactRecord」输入，非法数据直接返回明确错误。 */
export function normalizeArtifactRecord(value: ArtifactRecord): ArtifactRecord {
  const record = structuredClone(value);
  const revisions = record.revisions?.length ? record.revisions : [legacyRevision(record)];
  return {
    ...record,
    seriesId: record.seriesId ?? record.artifactId,
    version: record.version ?? 1,
    revisions,
  };
}

/** 执行「legacyRevision」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function legacyRevision(record: ArtifactRecord): ArtifactRevision {
  return {
    revisionId: `revision_${record.artifactId}`,
    primary: structuredClone(record.primary),
    ...(record.manifest ? { manifest: structuredClone(record.manifest) } : {}),
    sourceSessionId: record.sourceSessionId,
    sourceTurnId: record.sourceTurnId,
    operationId: record.operationId,
    createdAt: record.updatedAt,
  };
}

/** 判断「isArtifactRecord」对应条件，只返回判定结果且不修改输入状态。 */
function isArtifactRecord(value: unknown): value is ArtifactRecord {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  if (
    typeof value.artifactId !== "string" || typeof value.ownerId !== "string" ||
    typeof value.sourceSessionId !== "string" || typeof value.sourceTurnId !== "string" ||
    (value.kind !== "file" && value.kind !== "html_bundle") ||
    typeof value.displayName !== "string" || (value.state !== "active" && value.state !== "archived") ||
    typeof value.operationId !== "string" || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string" ||
    !isBlobRef(value.primary)
  ) return false;
  if (value.seriesId !== undefined && typeof value.seriesId !== "string") return false;
  if (value.version !== undefined && (!Number.isSafeInteger(value.version) || Number(value.version) < 1)) return false;
  if (value.revisions !== undefined && (!Array.isArray(value.revisions) || !value.revisions.every(isRevision))) return false;
  if (value.kind === "html_bundle") {
    if (!isRecord(value.manifest) || typeof value.manifest.entryPath !== "string" || !isRecord(value.manifest.files)) return false;
    return Object.values(value.manifest.files).every(isBlobRef);
  }
  return value.manifest === undefined;
}

/** 判断「isRevision」对应条件，只返回判定结果且不修改输入状态。 */
function isRevision(value: unknown): boolean {
  return isRecord(value) && typeof value.revisionId === "string" && isBlobRef(value.primary) &&
    typeof value.sourceSessionId === "string" && typeof value.sourceTurnId === "string" &&
    typeof value.operationId === "string" && typeof value.createdAt === "string" &&
    (value.manifest === undefined || (isRecord(value.manifest) && typeof value.manifest.entryPath === "string" &&
      isRecord(value.manifest.files) && Object.values(value.manifest.files).every(isBlobRef)));
}

/** 判断「isBlobRef」对应条件，只返回判定结果且不修改输入状态。 */
function isBlobRef(value: unknown): boolean {
  return isRecord(value) && /^[a-f0-9]{64}$/.test(String(value.sha256)) &&
    Number.isSafeInteger(value.byteLength) && Number(value.byteLength) >= 0 && typeof value.mimeType === "string";
}

/** 判断「isRecord」对应条件，只返回判定结果且不修改输入状态。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
