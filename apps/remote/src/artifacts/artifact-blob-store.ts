import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactBlobRef } from "@kindergarten/contracts";
import { ApiProblemError } from "../server/api-problem.js";

export class ArtifactBlobStore {
  constructor(private readonly root: string) {}

  async put(bytes: Uint8Array, mimeType: string): Promise<ArtifactBlobRef> {
    const content = Buffer.from(bytes);
    const sha256 = createHash("sha256").update(content).digest("hex");
    await mkdir(this.root, { recursive: true });
    try {
      const handle = await open(join(this.root, sha256), "wx", 0o600);
      try { await handle.writeFile(content); await handle.sync(); }
      finally { await handle.close(); }
    } catch (error) {
      if (!isExists(error)) throw error;
    }
    const ref = { sha256, byteLength: content.byteLength, mimeType };
    await this.read(ref);
    return ref;
  }

  async read(ref: ArtifactBlobRef): Promise<Buffer> {
    let bytes: Buffer;
    try { bytes = await readFile(join(this.root, ref.sha256)); }
    catch (error) {
      console.error("Artifact Blob 读取失败", error);
      throw new ApiProblemError(500, "ARTIFACT_BLOB_CORRUPT", "Artifact Blob 缺失或不可读", false);
    }
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== ref.byteLength || hash !== ref.sha256) {
      throw new ApiProblemError(500, "ARTIFACT_BLOB_CORRUPT", "Artifact Blob 完整性校验失败", false);
    }
    return bytes;
  }

  async prune(referencedHashes: Set<string>): Promise<void> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch((error: unknown) => {
      if (isMissing(error)) return [];
      throw error;
    });
    await Promise.all(entries.flatMap((entry) =>
      entry.isFile() && /^[a-f0-9]{64}$/.test(entry.name) && !referencedHashes.has(entry.name)
        ? [unlink(join(this.root, entry.name))]
        : []));
  }
}

function isExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
