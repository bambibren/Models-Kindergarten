/** 描述「FilePreviewKind」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type FilePreviewKind = "markdown" | "static_html" | "text" | "image" | "pdf" | "pptx" | "unsupported";

/** 描述「FileReference」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface FileReference {
  schemaVersion: 1;
  fileReferenceId: string;
  ownerId: string;
  sessionId: string;
  turnId: string;
  displayName: string;
  relativePath: string;
  mimeType: string;
  byteLength: number;
  sha256: string;
  previewKind: FilePreviewKind;
  createdAt: string;
}

/** 描述「FilePreviewResponse」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type FilePreviewResponse = {
  file: FileReference;
  content:
    | { kind: "markdown"; markdown: string }
    | { kind: "static_html"; html: string; csp: string }
    | { kind: "text"; text: string }
    | { kind: "image"; contentUrl: string }
    | { kind: "pdf"; contentUrl: string }
    | { kind: "pptx"; contentUrl: string }
    | { kind: "unsupported" };
};

const OPAQUE_FILE_ID = /^[A-Za-z0-9_-]{8,160}$/;

/** 校验并规范化「parseFileReferenceUri」输入，非法数据直接返回明确错误。 */
export function parseFileReferenceUri(value: string): string | undefined {
  const prefix = "mk-file://";
  if (!value.startsWith(prefix)) return undefined;
  const id = value.slice(prefix.length);
  return OPAQUE_FILE_ID.test(id) ? id : undefined;
}

/** 根据已校验输入构建「makeFileReferenceUri」结果，不额外持有调用方的大对象。 */
export function makeFileReferenceUri(fileReferenceId: string): string {
  if (!OPAQUE_FILE_ID.test(fileReferenceId)) throw new Error("fileReferenceId 必须是 opaque ID");
  return `mk-file://${fileReferenceId}`;
}
