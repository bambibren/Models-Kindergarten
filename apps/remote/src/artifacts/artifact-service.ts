import { randomUUID } from "node:crypto";
import { basename, extname, posix } from "node:path";
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
import { createZip } from "./zip-bundle.js";

const HTML_BUNDLE_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: data: http: https:; style-src 'unsafe-inline' blob: data: http: https:; img-src blob: data: http: https:; font-src blob: data: http: https:; media-src blob: data: http: https:; worker-src blob: data:; connect-src blob: data: http: https:; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri http: https:";

export interface PublishArtifactInput {
  ownerId: string;
  sessionId: string;
  turnId: string;
  operationId: string;
  path: string;
  displayName?: string;
}

export interface PublishHtmlBundleInput extends Omit<PublishArtifactInput, "path"> {
  rootPath?: string;
  entryPath: string;
}

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

export class ArtifactService {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly repository: ArtifactRepository,
    private readonly blobs: ArtifactBlobStore,
    private readonly workspacesRoot: string,
  ) {}

  async list(ownerId: string, options: { query?: string; state?: ArtifactState | "all" } = {}): Promise<ArtifactRecord[]> {
    const query = options.query?.trim().toLocaleLowerCase() ?? "";
    const state = options.state ?? "active";
    return (await this.repository.list())
      .filter((item) => item.ownerId === ownerId && (state === "all" || item.state === state))
      .filter((item) => !query || `${item.displayName}\n${item.artifactId}\n${item.primary.mimeType}`.toLocaleLowerCase().includes(query))
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.artifactId.localeCompare(right.artifactId));
  }

  async get(id: string, ownerId: string): Promise<ArtifactRecord> {
    const artifact = await this.repository.get(id);
    if (!artifact || artifact.ownerId !== ownerId) {
      throw new ApiProblemError(404, "ARTIFACT_FORBIDDEN", "Artifact 不存在或无权访问", false);
    }
    return artifact;
  }

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

  async publishFile(input: PublishArtifactInput): Promise<ArtifactRecord> {
    return this.mutate(async () => {
      const reused = await this.repository.byOperation(input.ownerId, requireOperation(input.operationId));
      if (reused) return reused;
      const staged = await this.stageFile(input);
      return this.insert({ input, ...staged });
    });
  }

  async publishHtmlBundle(input: PublishHtmlBundleInput): Promise<ArtifactRecord> {
    return this.mutate(async () => {
      const reused = await this.repository.byOperation(input.ownerId, requireOperation(input.operationId));
      if (reused) return reused;
      const staged = await this.stageHtmlBundle(input);
      return this.insert({ input, ...staged });
    });
  }

  async replaceFile(artifactId: string, input: PublishArtifactInput): Promise<ArtifactRecord> {
    return this.replace(artifactId, input, () => this.stageFile(input));
  }

  async replaceHtmlBundle(artifactId: string, input: PublishHtmlBundleInput): Promise<ArtifactRecord> {
    return this.replace(artifactId, input, () => this.stageHtmlBundle(input));
  }

  async publishFileVersion(artifactId: string, input: PublishArtifactInput): Promise<ArtifactRecord> {
    return this.publishVersion(artifactId, input, () => this.stageFile(input));
  }

  async publishHtmlBundleVersion(artifactId: string, input: PublishHtmlBundleInput): Promise<ArtifactRecord> {
    return this.publishVersion(artifactId, input, () => this.stageHtmlBundle(input));
  }

  async rollback(input: RollbackArtifactInput): Promise<ArtifactRecord> {
    return this.mutate(async () => {
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

  async content(id: string, ownerId: string): Promise<{ artifact: ArtifactRecord; bytes: Buffer }> {
    const artifact = await this.get(id, ownerId);
    return { artifact, bytes: await this.blobs.read(artifact.primary) };
  }

  async download(id: string, ownerId: string): Promise<{ artifact: ArtifactRecord; bytes: Buffer; mimeType: string; fileName: string }> {
    const artifact = await this.get(id, ownerId);
    if (artifact.kind === "file" || !artifact.manifest) {
      return { artifact, bytes: await this.blobs.read(artifact.primary), mimeType: artifact.primary.mimeType, fileName: artifact.displayName };
    }
    const files = await Promise.all(Object.entries(artifact.manifest.files).map(async ([path, ref]) => ({ path, bytes: await this.blobs.read(ref) })));
    const name = artifact.displayName.replace(/\.(html?|zip)$/i, "") || "html-bundle";
    return { artifact, bytes: createZip(files), mimeType: "application/zip", fileName: `${name}.zip` };
  }

  async bundleContent(id: string, path: string, ownerId: string): Promise<{ artifact: ArtifactRecord; ref: ArtifactBlobRef; bytes: Buffer }> {
    const artifact = await this.get(id, ownerId);
    const ref = bundleRef(artifact, path);
    return { artifact, ref, bytes: await this.blobs.read(ref) };
  }

  async preview(id: string, ownerId: string, publicBase = "/api/control/v1"): Promise<ArtifactPreviewResponse> {
    const artifact = await this.get(id, ownerId);
    const bytes = await this.blobs.read(artifact.primary);
    const contentUrl = `${publicBase}/artifacts/${encodeURIComponent(id)}/raw`;
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
    const kind = previewKind(artifact.displayName, artifact.primary.mimeType);
    if (kind === "markdown") return { artifact, content: { kind, markdown: previewText(bytes) } };
    if (kind === "text") return { artifact, content: { kind, text: previewText(bytes) } };
    if (kind === "static_html") return { artifact, content: { kind, html: bytes.toString("utf8"), csp: HTML_BUNDLE_CSP } };
    if (kind === "image" || kind === "pdf") return { artifact, content: { kind, contentUrl } };
    return { artifact, content: { kind: "unsupported", contentUrl } };
  }

  async setState(id: string, ownerId: string, state: ArtifactState): Promise<ArtifactRecord> {
    const value = await this.repository.setState(id, ownerId, state);
    if (!value) throw new ApiProblemError(404, "ARTIFACT_FORBIDDEN", "Artifact 不存在或无权访问", false);
    return value;
  }

  private async replace(
    artifactId: string,
    input: PublishArtifactInput | PublishHtmlBundleInput,
    stage: () => Promise<StagedArtifact>,
  ): Promise<ArtifactRecord> {
    return this.mutate(async () => {
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

  private async publishVersion(
    artifactId: string,
    input: PublishArtifactInput | PublishHtmlBundleInput,
    stage: () => Promise<StagedArtifact>,
  ): Promise<ArtifactRecord> {
    return this.mutate(async () => {
      const reused = await this.repository.byOperation(input.ownerId, requireOperation(input.operationId));
      if (reused) return reused;
      const base = await this.get(artifactId, input.ownerId);
      const staged = await stage();
      if (staged.kind !== base.kind) throw invalid("新版本的 Artifact 类型必须与原版本一致");
      const seriesId = base.seriesId ?? base.artifactId;
      const siblings = (await this.repository.list()).filter((item) =>
        item.ownerId === input.ownerId && (item.seriesId ?? item.artifactId) === seriesId);
      const version = Math.max(...siblings.map((item) => item.version ?? 1)) + 1;
      return this.insert({
        input,
        ...staged,
        displayName: input.displayName ? staged.displayName : base.displayName,
        seriesId,
        version,
      });
    });
  }

  private async stageFile(input: PublishArtifactInput): Promise<StagedArtifact> {
    const sandbox = await this.sandbox(input.sessionId);
    const { content } = await sandbox.readBytes(input.path, PRODUCT_CONFIG.artifact.maxFileBytes);
    return {
      kind: "file",
      displayName: safeDisplayName(input.displayName ?? basename(input.path)),
      primary: await this.blobs.put(content, mimeType(input.path)),
    };
  }

  private async stageHtmlBundle(input: PublishHtmlBundleInput): Promise<StagedArtifact> {
    const rootPath = cleanDirectory(input.rootPath ?? ".");
    const entryPath = cleanRelative(input.entryPath);
    if (![".html", ".htm"].includes(extname(entryPath).toLowerCase())) {
      throw invalid("HTML Bundle 入口必须是 .html 或 .htm 文件");
    }
    const sandbox = await this.sandbox(input.sessionId);
    const files = await sandbox.walkFiles(rootPath);
    const prefix = rootPath === "." ? "" : `${rootPath}/`;
    const selected = files.filter((item) => item.path.startsWith(prefix));
    const total = selected.reduce((sum, item) => sum + item.size, 0);
    if (total > PRODUCT_CONFIG.artifact.maxHtmlBundleBytes) {
      throw limit(`HTML Bundle 超过 ${PRODUCT_CONFIG.artifact.maxHtmlBundleBytes} 字节限制`);
    }
    const fullEntryPath = `${prefix}${entryPath}`;
    if (!selected.some((item) => item.path === fullEntryPath)) throw invalid(`HTML Bundle 入口不存在: ${entryPath}`);
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

  private async sandbox(sessionId: string): Promise<FileSandbox> {
    if (!sessionId || sessionId.includes("/") || sessionId.includes("\\")) throw invalid("sessionId 无效");
    const sandbox = new FileSandbox(posix.join(this.workspacesRoot.split("\\").join("/"), sessionId));
    await sandbox.initialize();
    return sandbox;
  }

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
      .filter((item) => item.ownerId === input.input.ownerId && item.sourceSessionId === input.input.sessionId && item.sourceTurnId === input.input.turnId)
      .reduce((sum, item) => sum + artifactBytes(item), 0);
    const nextBytes = input.manifest
      ? Object.values(input.manifest.files).reduce((sum, item) => sum + item.byteLength, 0)
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

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const guarded = async () => {
      try { return await operation(); }
      finally { await this.pruneBlobs(); }
    };
    const run = this.mutationTail.then(guarded, guarded);
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async pruneBlobs(): Promise<void> {
    const hashes = new Set<string>();
    for (const artifact of await this.repository.list()) collectArtifactHashes(artifact, hashes);
    await this.blobs.prune(hashes);
  }
}

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

function collectArtifactHashes(artifact: ArtifactRecord, result: Set<string>): void {
  collectBlobRef(artifact.primary, result);
  if (artifact.manifest) Object.values(artifact.manifest.files).forEach((ref) => collectBlobRef(ref, result));
  for (const revision of artifact.revisions ?? []) {
    collectBlobRef(revision.primary, result);
    if (revision.manifest) Object.values(revision.manifest.files).forEach((ref) => collectBlobRef(ref, result));
  }
}

function collectBlobRef(ref: ArtifactBlobRef, result: Set<string>): void {
  result.add(ref.sha256);
}

function artifactBytes(artifact: ArtifactRecord): number {
  return artifact.manifest
    ? Object.values(artifact.manifest.files).reduce((sum, item) => sum + item.byteLength, 0)
    : artifact.primary.byteLength;
}

function bundleRef(artifact: ArtifactRecord, path: string): ArtifactBlobRef {
  if (artifact.kind !== "html_bundle" || !artifact.manifest) throw invalid("Artifact 不是 HTML Bundle");
  const clean = cleanRelative(path);
  const ref = artifact.manifest.files[clean];
  if (!ref) throw new ApiProblemError(404, "ARTIFACT_RESOURCE_NOT_FOUND", "Artifact Bundle 资源不存在", false);
  return ref;
}

function cleanDirectory(path: string): string {
  if (path === ".") return path;
  return cleanRelative(path);
}

function cleanRelative(path: string): string {
  if (!path || path.startsWith("/") || path.includes("\\")) throw invalid("Artifact 路径必须是相对 POSIX 路径");
  const normalized = posix.normalize(path);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized !== path || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw invalid("Artifact 路径不允许空段、.、.. 或路径穿越");
  }
  return path;
}

function safeDisplayName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 255 || name.includes("/") || name.includes("\\")) throw invalid("Artifact 名称无效");
  return name;
}

function requireOperation(value: string): string {
  const operation = value.trim();
  if (!operation || operation.length > 160) throw invalid("operationId 无效");
  return operation;
}

function previewText(bytes: Buffer): string {
  if (bytes.byteLength > PRODUCT_CONFIG.artifact.maxTextPreviewBytes) throw limit("Artifact 文本超过预览上限，请下载查看");
  return bytes.toString("utf8");
}

function injectBase(html: string, href: string): string {
  const base = `<base href="${escapeAttribute(href)}">`;
  const head = /<head(?:\s[^>]*)?>/i;
  return head.test(html) ? html.replace(head, (opening) => `${opening}${base}`) : `${base}${html}`;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function previewKind(name: string, type: string): "markdown" | "static_html" | "text" | "image" | "pdf" | "unsupported" {
  const extension = extname(name).toLowerCase();
  if (type === "text/markdown" || extension === ".md" || extension === ".markdown") return "markdown";
  if (type === "text/html" || extension === ".html" || extension === ".htm") return "static_html";
  if (type.startsWith("text/") || type === "application/json") return "text";
  if (type.startsWith("image/")) return "image";
  if (type === "application/pdf") return "pdf";
  return "unsupported";
}

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

function invalid(detail: string): ApiProblemError {
  return new ApiProblemError(400, "ARTIFACT_VALIDATION_FAILED", detail, false);
}

function limit(detail: string): ApiProblemError {
  return new ApiProblemError(413, "ARTIFACT_RESOURCE_LIMIT", detail, false);
}
