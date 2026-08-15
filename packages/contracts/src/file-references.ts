export type FilePreviewKind = "markdown" | "static_html" | "text" | "image" | "pdf" | "unsupported";

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

export type FilePreviewResponse = {
  file: FileReference;
  content:
    | { kind: "markdown"; markdown: string }
    | { kind: "static_html"; html: string; csp: string }
    | { kind: "text"; text: string }
    | { kind: "image"; contentUrl: string }
    | { kind: "pdf"; contentUrl: string }
    | { kind: "unsupported" };
};

const OPAQUE_FILE_ID = /^[A-Za-z0-9_-]{8,160}$/;

export function parseFileReferenceUri(value: string): string | undefined {
  const prefix = "mk-file://";
  if (!value.startsWith(prefix)) return undefined;
  const id = value.slice(prefix.length);
  return OPAQUE_FILE_ID.test(id) ? id : undefined;
}

export function makeFileReferenceUri(fileReferenceId: string): string {
  if (!OPAQUE_FILE_ID.test(fileReferenceId)) throw new Error("fileReferenceId 必须是 opaque ID");
  return `mk-file://${fileReferenceId}`;
}
