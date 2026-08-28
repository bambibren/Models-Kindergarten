import { randomUUID } from "node:crypto";
import { basename, extname, posix } from "node:path";
import type { Readable } from "node:stream";
import type {
  ArtifactBlobRef,
  ArtifactMention,
  ArtifactPreviewResponse,
  ArtifactRecord,
  ArtifactRevision,
  ArtifactState,
  HtmlBundleManifest,
} from "@kindergarten/contracts";
import { makeArtifactUri, PRODUCT_CONFIG } from "@kindergarten/contracts";
import { ApiProblemError } from "../server/api-problem.js";
import { FileSandbox } from "../tools/sandbox.js";
import type { ArtifactBlobStore } from "./artifact-blob-store.js";
import type { ArtifactRepository } from "./artifact-repository.js";
import { createZip, createZipStream } from "./zip-bundle.js";

const HTML_BUNDLE_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: data: http: https:; style-src 'unsafe-inline' blob: data: http: https:; img-src blob: data: http: https:; font-src blob: data: http: https:; media-src blob: data: http: https:; worker-src blob: data:; connect-src blob: data: http: https:; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri http: https:";

/** 描述「PublishArtifactInput」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface PublishArtifactInput {
  ownerId: string;
  sessionId: string;
  turnId: string;
  operationId: string;
  path: string;
  displayName?: string;
}

/** 描述「PublishHtmlBundleInput」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface PublishHtmlBundleInput extends Omit<PublishArtifactInput, "path"> {
  rootPath?: string;
  entryPath: string;
}

/** 描述「RollbackArtifactInput」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface RollbackArtifactInput {
  artifactId: string;
  ownerId: string;
  sessionId: string;
  turnId: string;
  operationId: string;
  steps: number;
}

interface StagedArtifact {
  kind: ArtifactRecord["kind"];
  displayName: string;
  primary: ArtifactBlobRef;
  manifest?: HtmlBundleManifest;
}

/** 描述「ArtifactService」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export class ArtifactService {
  private mutationTail: Promise<void> = Promise.resolve();

  /** 初始化「ArtifactService」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(
    private readonly repository: ArtifactRepository,
    private readonly blobs: ArtifactBlobStore,
    private readonly workspacesRoot: string,
  ) {}

  /** 读取「list」所需数据，并遵守作用域、分页与容量边界。 */
async list(ownerId: string, options: { query?: string; state?: ArtifactState | "all" } = {}): Promise<ArtifactRecord[]> {
    const query = options.query?.trim().toLocaleLowerCase() ?? "";
    const state = options.state ?? "active";
    return (await this.repository.list())
      .filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.ownerId === ownerId && (state === "all" || item.state === state))
      .filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => !query || `${item.displayName}\n${item.artifactId}\n${item.primary.mimeType}`.toLocaleLowerCase().includes(query))
      .toSorted(/** 读取「list」所需数据，并遵守作用域、分页与容量边界。 */
(left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.artifactId.localeCompare(right.artifactId));
  }

  /** 读取「get」所需数据，并遵守作用域、分页与容量边界。 */
async get(id: string, ownerId: string): Promise<ArtifactRecord> {
    const artifact = await this.repository.get(id);
    if (!artifact || artifact.ownerId !== ownerId) {
      throw new ApiProblemError(404, "ARTIFACT_FORBIDDEN", "Artifact 不存在或无权访问", false);
    }
    return artifact;
  }

  /** 执行「resolveMentions」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async resolveMentions(ids: string[], ownerId: string): Promise<ArtifactMention[]> {
    const result: ArtifactMention[] = [];
    for (const id of [...new Set(ids)]) {
      const artifact = await this.get(id, ownerId);
      result.push({
        artifactId: artifact.artifactId,
        uri: makeArtifactUri(artifact.artifactId),
        displayName: artifact.displayName,
        kind: artifact.kind,
        mimeType: artifact.primary.mimeType,
        byteLength: artifact.primary.byteLength,
      });
    }
    return result;
  }

  /** 根据受控标识构造「publishFile」路径；调用方仍须执行归属与目录边界校验。 */
async publishFile(input: PublishArtifactInput): Promise<ArtifactRecord> {
    return this.mutate(/** 根据受控标识构造「publishFile」路径；调用方仍须执行归属与目录边界校验。 */
async () => {
      const reused = await this.repository.byOperation(input.ownerId, requireOperation(input.operationId));
      if (reused) return reused;
      const staged = await this.stageFile(input);
      return this.insert({ input, ...staged });
    });
  }

  /** 执行「publishHtmlBundle」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async publishHtmlBundle(input: PublishHtmlBundleInput): Promise<ArtifactRecord> {
    return this.mutate(/** 执行「publishHtmlBundle」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async () => {
      const reused = await this.repository.byOperation(input.ownerId, requireOperation(input.operationId));
      if (reused) return reused;
      const staged = await this.stageHtmlBundle(input);
      return this.insert({ input, ...staged });
    });
  }

  /** 根据受控标识构造「replaceFile」路径；调用方仍须执行归属与目录边界校验。 */
async replaceFile(artifactId: string, input: PublishArtifactInput): Promise<ArtifactRecord> {
    return this.replace(artifactId, input, /** 根据受控标识构造「replaceFile」路径；调用方仍须执行归属与目录边界校验。 */
() => this.stageFile(input));
  }

  /** 执行「replaceHtmlBundle」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async replaceHtmlBundle(artifactId: string, input: PublishHtmlBundleInput): Promise<ArtifactRecord> {
    return this.replace(artifactId, input, /** 执行「replaceHtmlBundle」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => this.stageHtmlBundle(input));
  }

  /** 执行「publishFileVersion」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async publishFileVersion(artifactId: string, input: PublishArtifactInput): Promise<ArtifactRecord> {
    return this.publishVersion(artifactId, input, /** 执行「publishFileVersion」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => this.stageFile(input));
  }

  /** 执行「publishHtmlBundleVersion」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async publishHtmlBundleVersion(artifactId: string, input: PublishHtmlBundleInput): Promise<ArtifactRecord> {
    return this.publishVersion(artifactId, input, /** 执行「publishHtmlBundleVersion」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => this.stageHtmlBundle(input));
  }

  /** 执行「rollback」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async rollback(input: RollbackArtifactInput): Promise<ArtifactRecord> {
    return this.mutate(/** 执行「rollback」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async () => {
      const reused = await this.repository.byOperation(input.ownerId, requireOperation(input.operationId));
      if (reused) return reused;
      const artifact = await this.get(input.artifactId, input.ownerId);
      const revisions = artifact.revisions ?? [];
      const maxSteps = Math.min(
        PRODUCT_CONFIG.artifact.maxRetainedRevisions - 1,
        revisions.length - 1,
      );
      if (!Number.isSafeInteger(input.steps) || input.steps < 1 || input.steps > maxSteps) {
        throw invalid(`steps 必须是 1 到 ${Math.max(0, maxSteps)} 的整数`);
      }
      const target = revisions[revisions.length - 1 - input.steps]!;
      const revision = makeRevision({
        primary: target.primary,
        ...(target.manifest ? { manifest: target.manifest } : {}),
        sourceSessionId: input.sessionId,
        sourceTurnId: input.turnId,
        operationId: input.operationId,
      });
      const updated = await this.repository.replaceCurrent(
        artifact.artifactId,
        input.ownerId,
        revision,
        artifact.displayName,
        PRODUCT_CONFIG.artifact.maxRetainedRevisions,
      );
      if (!updated) throw new ApiProblemError(404, "ARTIFACT_FORBIDDEN", "Artifact 不存在或无权访问", false);
      return updated;
    });
  }

  /** 执行「materialize」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async materialize(
    artifactId: string,
    ownerId: string,
    sessionId: string,
    targetPath: string,
    artifactPath?: string,
  ): Promise<{ artifact: ArtifactRecord; targetPath: string; bytes: number }> {
    const artifact = await this.get(artifactId, ownerId);
    const ref = artifactPath ? bundleRef(artifact, artifactPath) : artifact.primary;
    const bytes = await this.blobs.read(ref);
    const sandbox = await this.sandbox(sessionId);
    await sandbox.writeBytes(targetPath, bytes, PRODUCT_CONFIG.artifact.maxFileBytes);
    return { artifact, targetPath, bytes: bytes.byteLength };
  }

  /** 执行「content」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async content(id: string, ownerId: string): Promise<{ artifact: ArtifactRecord; bytes: Buffer }> {
    const artifact = await this.get(id, ownerId);
    return { artifact, bytes: await this.blobs.read(artifact.primary) };
  }

  /** HTTP 原始内容下载使用校验流，避免先分配完整 Blob Buffer。 */
  async contentStream(id: string, ownerId: string): Promise<{
    artifact: ArtifactRecord;
    stream: Readable;
    byteLength: number;
  }> {
    const artifact = await this.get(id, ownerId);
    return { artifact, stream: this.blobs.stream(artifact.primary), byteLength: artifact.primary.byteLength };
  }

  /** 执行「download」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async download(id: string, ownerId: string): Promise<{ artifact: ArtifactRecord; bytes: Buffer; mimeType: string; fileName: string }> {
    const artifact = await this.get(id, ownerId);
    if (artifact.kind === "file" || !artifact.manifest) {
      return { artifact, bytes: await this.blobs.read(artifact.primary), mimeType: artifact.primary.mimeType, fileName: artifact.displayName };
    }
    const files = await Promise.all(Object.entries(artifact.manifest.files).map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
async ([path, ref]) => ({ path, bytes: await this.blobs.read(ref) })));
    const name = artifact.displayName.replace(/\.(html?|zip)$/i, "") || "html-bundle";
    return { artifact, bytes: createZip(files), mimeType: "application/zip", fileName: `${name}.zip` };
  }

  /**
   * 文件 Artifact 直接返回 Blob 流；HTML Bundle 使用逐文件 ZIP 流，正文不会并行读入内存。
   */
  async downloadStream(id: string, ownerId: string): Promise<{
    artifact: ArtifactRecord;
    stream: Readable;
    byteLength: number;
    mimeType: string;
    fileName: string;
  }> {
    const artifact = await this.get(id, ownerId);
    if (artifact.kind === "file" || !artifact.manifest) {
      return {
        artifact,
        stream: this.blobs.stream(artifact.primary),
        byteLength: artifact.primary.byteLength,
        mimeType: artifact.primary.mimeType,
        fileName: artifact.displayName,
      };
    }
    const zip = createZipStream(Object.entries(artifact.manifest.files).map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
([path, ref]) => ({
      path,
      byteLength: ref.byteLength,
      open: /** 执行「open」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => this.blobs.stream(ref),
    })));
    const name = artifact.displayName.replace(/\.(html?|zip)$/i, "") || "html-bundle";
    return {
      artifact,
      stream: zip.stream,
      byteLength: zip.byteLength,
      mimeType: "application/zip",
      fileName: `${name}.zip`,
    };
  }

  /** 执行「bundleContent」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async bundleContent(id: string, path: string, ownerId: string): Promise<{ artifact: ArtifactRecord; ref: ArtifactBlobRef; bytes: Buffer }> {
    const artifact = await this.get(id, ownerId);
    const ref = bundleRef(artifact, path);
    return { artifact, ref, bytes: await this.blobs.read(ref) };
  }

  /** Bundle 子资源同样走完整性校验流。 */
  async bundleContentStream(id: string, path: string, ownerId: string): Promise<{
    artifact: ArtifactRecord;
    ref: ArtifactBlobRef;
    stream: Readable;
  }> {
    const artifact = await this.get(id, ownerId);
    const ref = bundleRef(artifact, path);
    return { artifact, ref, stream: this.blobs.stream(ref) };
  }

  /** 执行「preview」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async preview(id: string, ownerId: string, publicBase = "/api/control/v1"): Promise<ArtifactPreviewResponse> {
    const artifact = await this.get(id, ownerId);
    const contentUrl = `${publicBase}/artifacts/${encodeURIComponent(id)}/raw`;
    const kind = previewKind(artifact.displayName, artifact.primary.mimeType);
    // 二进制预览只返回 URL；浏览器是否读取由格式与大小策略决定。
    if (kind === "image" || kind === "pdf" || kind === "pptx") return { artifact, content: { kind, contentUrl } };
    if (kind === "unsupported") return { artifact, content: { kind, contentUrl } };
    const bytes = await this.blobs.read(artifact.primary);
    if (artifact.kind === "html_bundle") {
      const base = `${publicBase}/artifacts/${encodeURIComponent(id)}/bundle/`;
      return {
        artifact,
        content: {
          kind: "static_html",
          html: injectBase(bytes.toString("utf8"), base),
          csp: HTML_BUNDLE_CSP,
        },
      };
    }
    if (kind === "markdown") return { artifact, content: { kind, markdown: previewText(bytes) } };
    if (kind === "text") return { artifact, content: { kind, text: previewText(bytes) } };
    if (kind === "static_html") return { artifact, content: { kind, html: bytes.toString("utf8"), csp: HTML_BUNDLE_CSP } };
    return { artifact, content: { kind: "unsupported", contentUrl } };
  }

  /** 更新「setState」对应状态，并保持写入顺序、原子性与容量约束。 */
async setState(id: string, ownerId: string, state: ArtifactState): Promise<ArtifactRecord> {
    const value = await this.repository.setState(id, ownerId, state);
    if (!value) throw new ApiProblemError(404, "ARTIFACT_FORBIDDEN", "Artifact 不存在或无权访问", false);
    return value;
  }

  /** 执行「replace」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
private async replace(
    artifactId: string,
    input: PublishArtifactInput | PublishHtmlBundleInput,
    stage: () => Promise<StagedArtifact>,
  ): Promise<ArtifactRecord> {
    return this.mutate(/** 执行「replace」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async () => {
      const reused = await this.repository.byOperation(input.ownerId, requireOperation(input.operationId));
      if (reused) return reused;
      const artifact = await this.get(artifactId, input.ownerId);
      if (artifact.sourceSessionId !== input.sessionId) {
        throw invalid("跨 Session 修改必须使用 publish_artifact_version 创建新的 vN");
      }
      const staged = await stage();
      if (staged.kind !== artifact.kind) throw invalid("覆盖发布的 Artifact 类型必须与原版本一致");
      const revision = makeRevision({
        primary: staged.primary,
        ...(staged.manifest ? { manifest: staged.manifest } : {}),
        sourceSessionId: input.sessionId,
        sourceTurnId: input.turnId,
        operationId: input.operationId,
      });
      const updated = await this.repository.replaceCurrent(
        artifact.artifactId,
        input.ownerId,
        revision,
        input.displayName ? staged.displayName : artifact.displayName,
        PRODUCT_CONFIG.artifact.maxRetainedRevisions,
      );
      if (!updated) throw new ApiProblemError(404, "ARTIFACT_FORBIDDEN", "Artifact 不存在或无权访问", false);
      return updated;
    });
  }

  /** 执行「publishVersion」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
private async publishVersion(
    artifactId: string,
    input: PublishArtifactInput | PublishHtmlBundleInput,
    stage: () => Promise<StagedArtifact>,
  ): Promise<ArtifactRecord> {
    return this.mutate(/** 执行「publishVersion」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async () => {
      const reused = await this.repository.byOperation(input.ownerId, requireOperation(input.operationId));
      if (reused) return reused;
      const base = await this.get(artifactId, input.ownerId);
      const staged = await stage();
      if (staged.kind !== base.kind) throw invalid("新版本的 Artifact 类型必须与原版本一致");
      const seriesId = base.seriesId ?? base.artifactId;
      const siblings = (await this.repository.list()).filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) =>
        item.ownerId === input.ownerId && (item.seriesId ?? item.artifactId) === seriesId);
      const version = Math.max(...siblings.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.version ?? 1)) + 1;
      return this.insert({
        input,
        ...staged,
        displayName: input.displayName ? staged.displayName : base.displayName,
        seriesId,
        version,
      });
    });
  }

  /** 根据受控标识构造「stageFile」路径；调用方仍须执行归属与目录边界校验。 */
private async stageFile(input: PublishArtifactInput): Promise<StagedArtifact> {
    const sandbox = await this.sandbox(input.sessionId);
    const { content } = await sandbox.readBytes(input.path, PRODUCT_CONFIG.artifact.maxFileBytes);
    return {
      kind: "file",
      displayName: safeDisplayName(input.displayName ?? basename(input.path)),
      primary: await this.blobs.put(content, mimeType(input.path)),
    };
  }

  /** 执行「stageHtmlBundle」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
private async stageHtmlBundle(input: PublishHtmlBundleInput): Promise<StagedArtifact> {
    const rootPath = cleanDirectory(input.rootPath ?? ".");
    const entryPath = cleanRelative(input.entryPath);
    if (![".html", ".htm"].includes(extname(entryPath).toLowerCase())) {
      throw invalid("HTML Bundle 入口必须是 .html 或 .htm 文件");
    }
    const sandbox = await this.sandbox(input.sessionId);
    const files = await sandbox.walkFiles(rootPath, PRODUCT_CONFIG.artifact.maxHtmlBundleFiles);
    if (files.length > PRODUCT_CONFIG.artifact.maxHtmlBundleFiles) {
      throw limit(`HTML Bundle 文件数超过 ${PRODUCT_CONFIG.artifact.maxHtmlBundleFiles} 个限制`);
    }
    const prefix = rootPath === "." ? "" : `${rootPath}/`;
    const selected = files.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.path.startsWith(prefix));
    const total = selected.reduce(/** 把当前元素归并到有限累加状态，避免额外复制完整集合。 */
(sum, item) => sum + item.size, 0);
    if (total > PRODUCT_CONFIG.artifact.maxHtmlBundleBytes) {
      throw limit(`HTML Bundle 超过 ${PRODUCT_CONFIG.artifact.maxHtmlBundleBytes} 字节限制`);
    }
    const fullEntryPath = `${prefix}${entryPath}`;
    if (!selected.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.path === fullEntryPath)) throw invalid(`HTML Bundle 入口不存在: ${entryPath}`);
    const manifestFiles: Record<string, ArtifactBlobRef> = {};
    for (const file of selected) {
      if (file.size > PRODUCT_CONFIG.artifact.maxFileBytes) {
        throw limit(`HTML Bundle 文件超过 ${PRODUCT_CONFIG.artifact.maxFileBytes} 字节限制: ${file.path}`);
      }
      const relativePath = file.path.slice(prefix.length);
      const { content } = await sandbox.readBytes(file.path, PRODUCT_CONFIG.artifact.maxFileBytes);
      manifestFiles[relativePath] = await this.blobs.put(content, mimeType(relativePath));
    }
    const primary = manifestFiles[entryPath];
    if (!primary) throw invalid(`HTML Bundle 入口不存在: ${entryPath}`);
    return {
      kind: "html_bundle",
      displayName: safeDisplayName(input.displayName ?? basename(entryPath)),
      primary,
      manifest: { entryPath, files: manifestFiles },
    };
  }

  /** 执行「sandbox」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
private async sandbox(sessionId: string): Promise<FileSandbox> {
    if (!sessionId || sessionId.includes("/") || sessionId.includes("\\")) throw invalid("sessionId 无效");
    const sandbox = new FileSandbox(posix.join(this.workspacesRoot.split("\\").join("/"), sessionId));
    await sandbox.initialize();
    return sandbox;
  }

  /** 更新「insert」对应状态，并保持写入顺序、原子性与容量约束。 */
private async insert(input: {
    input: Pick<PublishArtifactInput, "ownerId" | "sessionId" | "turnId" | "operationId">;
    kind: ArtifactRecord["kind"];
    displayName: string;
    primary: ArtifactBlobRef;
    manifest?: ArtifactRecord["manifest"];
    seriesId?: string;
    version?: number;
  }): Promise<ArtifactRecord> {
    const existing = await this.repository.byOperation(input.input.ownerId, input.input.operationId);
    if (existing) return existing;
    const alreadyStaged = (await this.repository.list())
      .filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.ownerId === input.input.ownerId && item.sourceSessionId === input.input.sessionId && item.sourceTurnId === input.input.turnId)
      .reduce(/** 把当前元素归并到有限累加状态，避免额外复制完整集合。 */
(sum, item) => sum + artifactBytes(item), 0);
    const nextBytes = input.manifest
      ? Object.values(input.manifest.files).reduce(/** 把当前元素归并到有限累加状态，避免额外复制完整集合。 */
(sum, item) => sum + item.byteLength, 0)
      : input.primary.byteLength;
    if (alreadyStaged + nextBytes > PRODUCT_CONFIG.artifact.maxTurnStagingBytes) {
      throw limit(`当前 Turn 的 Artifact staging 超过 ${PRODUCT_CONFIG.artifact.maxTurnStagingBytes} 字节限制`);
    }
    const now = new Date().toISOString();
    const artifactId = `artifact_${randomUUID().replaceAll("-", "")}`;
    const revision = makeRevision({
      primary: input.primary,
      ...(input.manifest ? { manifest: input.manifest } : {}),
      sourceSessionId: input.input.sessionId,
      sourceTurnId: input.input.turnId,
      operationId: input.input.operationId,
      createdAt: now,
    });
    const record: ArtifactRecord = {
      schemaVersion: 1,
      artifactId,
      ownerId: input.input.ownerId,
      sourceSessionId: input.input.sessionId,
      sourceTurnId: input.input.turnId,
      kind: input.kind,
      displayName: input.displayName,
      state: "active",
      seriesId: input.seriesId ?? artifactId,
      version: input.version ?? 1,
      primary: input.primary,
      ...(input.manifest ? { manifest: input.manifest } : {}),
      revisions: [revision],
      operationId: input.input.operationId,
      createdAt: now,
      updatedAt: now,
    };
    try { await this.repository.insert(record); }
    catch (error) {
      const raced = await this.repository.byOperation(input.input.ownerId, input.input.operationId);
      if (raced) return raced;
      throw error;
    }
    return record;
  }

  /** 执行「mutate」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const guarded = /** 执行「guarded」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async () => {
      try { return await operation(); }
      finally { await this.pruneBlobs(); }
    };
    const run = this.mutationTail.then(guarded, guarded);
    this.mutationTail = run.then(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => undefined, /** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => undefined);
    return run;
  }

  /** 释放或删除「pruneBlobs」对应资源，重复调用仍保持安全。 */
private async pruneBlobs(): Promise<void> {
    const hashes = new Set<string>();
    for (const artifact of await this.repository.list()) collectArtifactHashes(artifact, hashes);
    await this.blobs.prune(hashes);
  }
}

/** 根据已校验输入构建「makeRevision」结果，不额外持有调用方的大对象。 */
function makeRevision(input: {
  primary: ArtifactBlobRef;
  manifest?: HtmlBundleManifest;
  sourceSessionId: string;
  sourceTurnId: string;
  operationId: string;
  createdAt?: string;
}): ArtifactRevision {
  return {
    revisionId: `revision_${randomUUID().replaceAll("-", "")}`,
    primary: structuredClone(input.primary),
    ...(input.manifest ? { manifest: structuredClone(input.manifest) } : {}),
    sourceSessionId: input.sourceSessionId,
    sourceTurnId: input.sourceTurnId,
    operationId: input.operationId,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

/** 执行「collectArtifactHashes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function collectArtifactHashes(artifact: ArtifactRecord, result: Set<string>): void {
  collectBlobRef(artifact.primary, result);
  if (artifact.manifest) Object.values(artifact.manifest.files).forEach(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(ref) => collectBlobRef(ref, result));
  for (const revision of artifact.revisions ?? []) {
    collectBlobRef(revision.primary, result);
    if (revision.manifest) Object.values(revision.manifest.files).forEach(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(ref) => collectBlobRef(ref, result));
  }
}

/** 执行「collectBlobRef」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function collectBlobRef(ref: ArtifactBlobRef, result: Set<string>): void {
  result.add(ref.sha256);
}

/** 执行「artifactBytes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function artifactBytes(artifact: ArtifactRecord): number {
  return artifact.manifest
    ? Object.values(artifact.manifest.files).reduce(/** 把当前元素归并到有限累加状态，避免额外复制完整集合。 */
(sum, item) => sum + item.byteLength, 0)
    : artifact.primary.byteLength;
}

/** 执行「bundleRef」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function bundleRef(artifact: ArtifactRecord, path: string): ArtifactBlobRef {
  if (artifact.kind !== "html_bundle" || !artifact.manifest) throw invalid("Artifact 不是 HTML Bundle");
  const clean = cleanRelative(path);
  const ref = artifact.manifest.files[clean];
  if (!ref) throw new ApiProblemError(404, "ARTIFACT_RESOURCE_NOT_FOUND", "Artifact Bundle 资源不存在", false);
  return ref;
}

/** 根据受控标识构造「cleanDirectory」路径；调用方仍须执行归属与目录边界校验。 */
function cleanDirectory(path: string): string {
  if (path === ".") return path;
  return cleanRelative(path);
}

/** 执行「cleanRelative」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function cleanRelative(path: string): string {
  if (!path || path.startsWith("/") || path.includes("\\")) throw invalid("Artifact 路径必须是相对 POSIX 路径");
  const normalized = posix.normalize(path);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized !== path || path.split("/").some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(part) => !part || part === "." || part === "..")) {
    throw invalid("Artifact 路径不允许空段、.、.. 或路径穿越");
  }
  return path;
}

/** 执行「safeDisplayName」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function safeDisplayName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 255 || name.includes("/") || name.includes("\\")) throw invalid("Artifact 名称无效");
  return name;
}

/** 校验并取得「requireOperation」所需对象；缺失或归属不符时立即抛出明确错误。 */
function requireOperation(value: string): string {
  const operation = value.trim();
  if (!operation || operation.length > 160) throw invalid("operationId 无效");
  return operation;
}

/** 执行「previewText」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function previewText(bytes: Buffer): string {
  if (bytes.byteLength > PRODUCT_CONFIG.artifact.maxTextPreviewBytes) throw limit("Artifact 文本超过预览上限，请下载查看");
  return bytes.toString("utf8");
}

/** 执行「injectBase」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function injectBase(html: string, href: string): string {
  const base = `<base href="${escapeAttribute(href)}">`;
  const head = /<head(?:\s[^>]*)?>/i;
  return head.test(html) ? html.replace(head, /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(opening) => `${opening}${base}`) : `${base}${html}`;
}

/** 执行「escapeAttribute」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

/** 执行「previewKind」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function previewKind(name: string, type: string): "markdown" | "static_html" | "text" | "image" | "pdf" | "pptx" | "unsupported" {
  const extension = extname(name).toLowerCase();
  if (type === "text/markdown" || extension === ".md" || extension === ".markdown") return "markdown";
  if (type === "text/html" || extension === ".html" || extension === ".htm") return "static_html";
  if (type.startsWith("text/") || type === "application/json") return "text";
  if (type.startsWith("image/")) return "image";
  if (type === "application/pdf") return "pdf";
  if (type === "application/vnd.openxmlformats-officedocument.presentationml.presentation" || extension === ".pptx") return "pptx";
  return "unsupported";
}

/** 执行「mimeType」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function mimeType(path: string): string {
  const extension = extname(path).toLowerCase();
  const known: Record<string, string> = {
    ".html": "text/html", ".htm": "text/html", ".css": "text/css", ".js": "text/javascript",
    ".mjs": "text/javascript", ".json": "application/json", ".md": "text/markdown", ".txt": "text/plain",
    ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".pdf": "application/pdf",
    ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
    ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
  return known[extension] ?? "application/octet-stream";
}

/** 执行「invalid」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function invalid(detail: string): ApiProblemError {
  return new ApiProblemError(400, "ARTIFACT_VALIDATION_FAILED", detail, false);
}

/** 执行「limit」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function limit(detail: string): ApiProblemError {
  return new ApiProblemError(413, "ARTIFACT_RESOURCE_LIMIT", detail, false);
}
