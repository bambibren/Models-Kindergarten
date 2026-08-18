import type { ArtifactRecord, ArtifactRevision, ArtifactState } from "@kindergarten/contracts";
import { AtomicJsonStore } from "../storage/atomic-json-store.js";

export class ArtifactRepository {
  private readonly store: AtomicJsonStore<ArtifactRecord>;

  constructor(file: string) {
    this.store = new AtomicJsonStore({ file, schemaVersion: 1, validate: isArtifactRecord });
  }

  async list(): Promise<ArtifactRecord[]> {
    return (await this.store.read()).map(normalizeArtifactRecord);
  }

  async get(id: string): Promise<ArtifactRecord | undefined> {
    const value = (await this.store.read()).find((item) => item.artifactId === id);
    return value ? normalizeArtifactRecord(value) : undefined;
  }

  async byOperation(ownerId: string, operationId: string): Promise<ArtifactRecord | undefined> {
    const value = (await this.store.read()).find((item) =>
      item.ownerId === ownerId && (item.operationId === operationId ||
        item.revisions?.some((revision) => revision.operationId === operationId)));
    return value ? normalizeArtifactRecord(value) : undefined;
  }

  async insert(value: ArtifactRecord): Promise<void> {
    await this.store.update((records) => {
      if (records.some((item) => item.artifactId === value.artifactId)) throw new Error("Artifact 已存在");
      if (records.some((item) => item.ownerId === value.ownerId && item.operationId === value.operationId)) {
        throw new Error("Artifact operationId 已存在");
      }
      return [...records, structuredClone(value)];
    });
  }

  async replaceCurrent(
    id: string,
    ownerId: string,
    revision: ArtifactRevision,
    displayName: string,
    maxRetainedRevisions: number,
  ): Promise<ArtifactRecord | undefined> {
    return this.store.update((records) => {
      const index = records.findIndex((item) => item.artifactId === id && item.ownerId === ownerId);
      if (index < 0) return { records, result: undefined };
      const current = normalizeArtifactRecord(records[index]!);
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
      const changed = [...records];
      changed[index] = next;
      return { records: changed, result: structuredClone(next) };
    });
  }

  async setState(id: string, ownerId: string, state: ArtifactState): Promise<ArtifactRecord | undefined> {
    return this.store.update((records) => {
      const index = records.findIndex((item) => item.artifactId === id && item.ownerId === ownerId);
      if (index < 0) return { records, result: undefined };
      const current = records[index]!;
      const next = { ...current, state, updatedAt: new Date().toISOString() } satisfies ArtifactRecord;
      const changed = [...records];
      changed[index] = next;
      return { records: changed, result: structuredClone(next) };
    });
  }
}

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

function isRevision(value: unknown): boolean {
  return isRecord(value) && typeof value.revisionId === "string" && isBlobRef(value.primary) &&
    typeof value.sourceSessionId === "string" && typeof value.sourceTurnId === "string" &&
    typeof value.operationId === "string" && typeof value.createdAt === "string" &&
    (value.manifest === undefined || (isRecord(value.manifest) && typeof value.manifest.entryPath === "string" &&
      isRecord(value.manifest.files) && Object.values(value.manifest.files).every(isBlobRef)));
}

function isBlobRef(value: unknown): boolean {
  return isRecord(value) && /^[a-f0-9]{64}$/.test(String(value.sha256)) &&
    Number.isSafeInteger(value.byteLength) && Number(value.byteLength) >= 0 && typeof value.mimeType === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
