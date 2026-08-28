import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactBlobRef } from "@kindergarten/contracts";
import { ApiProblemError } from "../server/api-problem.js";

/** 描述「ArtifactBlobStore」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export class ArtifactBlobStore {
  /** 初始化「ArtifactBlobStore」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(private readonly root: string) {}

  /** 更新「put」对应状态，并保持写入顺序、原子性与容量约束。 */
async put(bytes: Uint8Array, mimeType: string): Promise<ArtifactBlobRef> {
    return this.putStream(Readable.from([bytes]), mimeType);
  }

  /**
   * 内容边写临时文件边计算摘要，完成前不会以正式 SHA 文件名暴露。
   * 该方法不会把输入重新拼成一份完整 Buffer。
   */
  async putStream(source: AsyncIterable<Uint8Array>, mimeType: string): Promise<ArtifactBlobRef> {
    await mkdir(this.root, { recursive: true });
    const temporary = join(this.root, `.upload-${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    const hash = createHash("sha256");
    let byteLength = 0;
    try {
      for await (const value of source) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        byteLength += chunk.byteLength;
        hash.update(chunk);
        await handle.write(chunk);
      }
      await handle.sync();
    } catch (error) {
      await handle.close().catch(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => undefined);
      await unlink(temporary).catch(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => undefined);
      throw error;
    } finally {
      await handle.close().catch(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => undefined);
    }
    const sha256 = hash.digest("hex");
    const destination = join(this.root, sha256);
    try {
      await rename(temporary, destination);
    } catch (error) {
      if (!isExists(error)) throw error;
      await unlink(temporary).catch(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => undefined);
    }
    const ref = { sha256, byteLength, mimeType };
    await this.verify(ref);
    return ref;
  }

  /** 兼容确实需要随机访问的调用；底层仍通过流完成完整性校验。 */
  async read(ref: ArtifactBlobRef): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of this.stream(ref)) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks, ref.byteLength);
  }

  /**
   * 返回带 SHA-256 与字节数校验的读取流。校验在流结束前完成，HTTP 下载链路无需
   * 先把整个 Blob 放入堆内存。
   */
  stream(ref: ArtifactBlobRef): Readable {
    const file = join(this.root, ref.sha256);
    const hash = createHash("sha256");
    let byteLength = 0;
    const integrity = new Transform({
      /** 执行「transform」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
transform(chunk: Buffer, _encoding, callback) {
        byteLength += chunk.byteLength;
        hash.update(chunk);
        callback(null, chunk);
      },
      /** 执行「flush」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
flush(callback) {
        const actualHash = hash.digest("hex");
        if (byteLength !== ref.byteLength || actualHash !== ref.sha256) {
          callback(corrupt("Artifact Blob 完整性校验失败"));
          return;
        }
        callback();
      },
    });
    const source = createReadStream(file);
    source.on("error", /** 执行「stream」主流程，传播取消与失败并在结束时清理临时资源。 */
() => integrity.destroy(corrupt("Artifact Blob 缺失或不可读")));
    return source.pipe(integrity);
  }

  /** 完整消费校验流，但不保留内容。 */
  private async verify(ref: ArtifactBlobRef): Promise<void> {
    try {
      const metadata = await stat(join(this.root, ref.sha256));
      if (metadata.size !== ref.byteLength) throw corrupt("Artifact Blob 完整性校验失败");
      for await (const _chunk of this.stream(ref)) {
        // 消费即可；Transform 在 flush 中核对最终摘要。
      }
    } catch (error) {
      if (error instanceof ApiProblemError) throw error;
      throw corrupt("Artifact Blob 缺失或不可读");
    }
  }

  /** 释放或删除「prune」对应资源，重复调用仍保持安全。 */
async prune(referencedHashes: Set<string>): Promise<void> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
(error: unknown) => {
      if (isMissing(error)) return [];
      throw error;
    });
    await Promise.all(entries.flatMap(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(entry) =>
      entry.isFile() && /^[a-f0-9]{64}$/.test(entry.name) && !referencedHashes.has(entry.name)
        ? [unlink(join(this.root, entry.name))]
        : []));
  }
}

/** 统一生成不会向调用方泄露本机路径的完整性错误。 */
function corrupt(message: string): ApiProblemError {
  return new ApiProblemError(500, "ARTIFACT_BLOB_CORRUPT", message, false);
}

/** 判断「isExists」对应条件，只返回判定结果且不修改输入状态。 */
function isExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

/** 判断「isMissing」对应条件，只返回判定结果且不修改输入状态。 */
function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
