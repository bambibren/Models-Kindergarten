import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { FilePreviewResponse, FileReference } from "@kindergarten/contracts";
import { ApiProblemError } from "../server/api-problem.js";
import { FileSandbox } from "../tools/sandbox.js";
import type { FileReferenceRepository } from "./file-reference-repository.js";

const STATIC_HTML_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'";

export class FileReferenceService {
  constructor(
    private readonly repository: FileReferenceRepository,
    private readonly workspacesRoot: string,
    private readonly blobsRoot: string,
  ) {}

  async createFromPaths(
    ownerId: string,
    sessionId: string,
    turnId: string,
    relativePaths: string[],
  ): Promise<FileReference[]> {
    const existing = await this.repository.list();
    const sandbox = new FileSandbox(join(this.workspacesRoot, sessionId));
    await sandbox.initialize();
    const files: FileReference[] = [];
    for (const relativePath of [...new Set(relativePaths)]) {
      const reused = existing.find((item) => item.ownerId === ownerId && item.sessionId === sessionId &&
        item.turnId === turnId && item.relativePath === relativePath);
      if (reused) { files.push(reused); continue; }
      const { content } = await sandbox.readBytes(relativePath);
      const fileReferenceId = `file_${randomUUID().replaceAll("-", "")}`;
      await this.writeBlob(fileReferenceId, content);
      const format = fileFormat(relativePath);
      const value: FileReference = {
        schemaVersion: 1,
        fileReferenceId,
        ownerId,
        sessionId,
        turnId,
        displayName: basename(relativePath),
        relativePath,
        mimeType: format.mimeType,
        byteLength: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex"),
        previewKind: format.previewKind,
        createdAt: new Date().toISOString(),
      };
      await this.repository.insert(value);
      files.push(value);
    }
    return files;
  }

  async get(id: string, ownerId = "local-admin"): Promise<FileReference> {
    const value = await this.repository.get(id);
    if (!value || value.ownerId !== ownerId) {
      throw new ApiProblemError(404, "FILE_REFERENCE_FORBIDDEN", "文件引用不存在或无权访问", false);
    }
    return value;
  }

  async preview(id: string, ownerId = "local-admin"): Promise<FilePreviewResponse> {
    const file = await this.get(id, ownerId);
    const content = await this.readVerified(file);
    if (file.previewKind === "markdown") return { file, content: { kind: "markdown", markdown: content.toString("utf8") } };
    if (file.previewKind === "text") return { file, content: { kind: "text", text: content.toString("utf8") } };
    if (file.previewKind === "static_html") {
      return { file, content: { kind: "static_html", html: sanitizeStaticHtml(content.toString("utf8")), csp: STATIC_HTML_CSP } };
    }
    if (file.previewKind === "image" || file.previewKind === "pdf") {
      return { file, content: { kind: file.previewKind, contentUrl: `/api/control/v1/files/${file.fileReferenceId}/content` } };
    }
    return { file, content: { kind: "unsupported" } };
  }

  async content(id: string, ownerId = "local-admin"): Promise<{ file: FileReference; bytes: Buffer }> {
    const file = await this.get(id, ownerId);
    if (file.previewKind !== "image" && file.previewKind !== "pdf") {
      throw new ApiProblemError(409, "FILE_PREVIEW_NOT_SUPPORTED", "该文件不能通过二进制内容端点预览", false);
    }
    return { file, bytes: await this.readVerified(file) };
  }

  private async writeBlob(id: string, content: Buffer): Promise<void> {
    await mkdir(this.blobsRoot, { recursive: true });
    const handle = await open(join(this.blobsRoot, id), "wx", 0o600);
    try { await handle.writeFile(content); await handle.sync(); }
    finally { await handle.close(); }
  }

  private async readVerified(file: FileReference): Promise<Buffer> {
    const bytes = await readFile(join(this.blobsRoot, file.fileReferenceId));
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== file.byteLength || hash !== file.sha256) {
      throw new ApiProblemError(500, "INTERNAL_ERROR", "文件引用内容校验失败", false);
    }
    return bytes;
  }
}

function fileFormat(path: string): Pick<FileReference, "mimeType" | "previewKind"> {
  const extension = extname(path).toLowerCase();
  if (extension === ".md" || extension === ".markdown") return { mimeType: "text/markdown", previewKind: "markdown" };
  if (extension === ".html" || extension === ".htm") return { mimeType: "text/html", previewKind: "static_html" };
  if ([".txt", ".json", ".css", ".js", ".ts", ".tsx", ".jsx", ".csv"].includes(extension)) {
    return { mimeType: extension === ".json" ? "application/json" : "text/plain", previewKind: "text" };
  }
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(extension)) {
    const mimeType = extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : `image/${extension.slice(1)}`;
    return { mimeType, previewKind: "image" };
  }
  if (extension === ".pdf") return { mimeType: "application/pdf", previewKind: "pdf" };
  return { mimeType: "application/octet-stream", previewKind: "unsupported" };
}

export function sanitizeStaticHtml(value: string): string {
  return value
    .replace(/<(script|iframe|object|embed|form|input|button|textarea|select|option|link|meta|base)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(script|iframe|object|embed|form|input|button|textarea|select|option|link|meta|base)\b[^>]*\/?>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s+(href|src|action|formaction)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/@import\s+[^;]+;?/gi, "")
    .replace(/url\s*\([^)]*\)/gi, "none");
}
