import type { FileReference } from "@kindergarten/contracts";
import { AtomicJsonStore } from "../storage/atomic-json-store.js";

export class FileReferenceRepository {
  private readonly store: AtomicJsonStore<FileReference>;

  constructor(file: string) {
    this.store = new AtomicJsonStore({ file, schemaVersion: 1, validate: isFileReference });
  }

  list(): Promise<FileReference[]> { return this.store.read(); }

  async get(id: string): Promise<FileReference | undefined> {
    return (await this.store.read()).find((item) => item.fileReferenceId === id);
  }

  async insert(value: FileReference): Promise<void> {
    await this.store.update((records) => {
      if (records.some((item) => item.fileReferenceId === value.fileReferenceId)) throw new Error("FileReference 已存在");
      return [...records, value];
    });
  }
}

function isFileReference(value: unknown): value is FileReference {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Partial<FileReference>;
  return item.schemaVersion === 1 && typeof item.fileReferenceId === "string" && typeof item.ownerId === "string" &&
    typeof item.sessionId === "string" && typeof item.turnId === "string" && typeof item.relativePath === "string" &&
    typeof item.byteLength === "number" && typeof item.sha256 === "string" && typeof item.createdAt === "string";
}
