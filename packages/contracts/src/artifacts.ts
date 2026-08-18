export type ArtifactKind = "file" | "html_bundle";
export type ArtifactState = "active" | "archived";

export interface ArtifactBlobRef {
  sha256: string;
  byteLength: number;
  mimeType: string;
}

export interface HtmlBundleManifest {
  entryPath: string;
  files: Record<string, ArtifactBlobRef>;
}

/** 同一用户可见版本内的内部修订；没有独立 Artifact URI，只能通过回滚恢复。 */
export interface ArtifactRevision {
  revisionId: string;
  primary: ArtifactBlobRef;
  manifest?: HtmlBundleManifest;
  sourceSessionId: string;
  sourceTurnId: string;
  operationId: string;
  createdAt: string;
}

export interface ArtifactRecord {
  schemaVersion: 1;
  artifactId: string;
  ownerId: string;
  sourceSessionId: string;
  sourceTurnId: string;
  kind: ArtifactKind;
  displayName: string;
  state: ArtifactState;
  /** 旧记录缺失时按 artifactId 作为 seriesId。 */
  seriesId?: string;
  /** 用户可见版本号；旧记录缺失时按 v1。 */
  version?: number;
  primary: ArtifactBlobRef;
  manifest?: HtmlBundleManifest;
  /** 包含当前内容在内的最近修订，旧记录缺失时由 Remote 惰性补成一条。 */
  revisions?: ArtifactRevision[];
  operationId: string;
  createdAt: string;
  updatedAt: string;
}

/** Browser 只提交稳定 ID；展示字段必须由 Remote 重新解析，不能信任客户端。 */
export interface ArtifactMentionInput {
  artifactId: string;
}

/** Session/ACP 中保存的已授权只读引用，不包含 Blob 字节或 Workspace 路径。 */
export interface ArtifactMention {
  artifactId: string;
  uri: string;
  displayName: string;
  kind: ArtifactKind;
  mimeType: string;
  byteLength: number;
}

export interface ArtifactListResponse {
  items: ArtifactRecord[];
}

export type ArtifactPreviewResponse = {
  artifact: ArtifactRecord;
  content:
    | { kind: "markdown"; markdown: string }
    | { kind: "static_html"; html: string; csp: string }
    | { kind: "text"; text: string }
    | { kind: "image"; contentUrl: string }
    | { kind: "pdf"; contentUrl: string }
    | { kind: "pptx"; contentUrl: string }
    | { kind: "unsupported"; contentUrl: string };
};

export interface PptxPlaybackResponse {
  documentServerApiUrl: string;
  config: {
    type: "embedded";
    documentType: "slide";
    document: {
      fileType: "pptx";
      key: string;
      title: string;
      url: string;
      permissions: { download: false; edit: false; print: false };
    };
    editorConfig: {
      lang: "zh-CN";
      mode: "view";
      customization: {
        compactHeader: true;
        hideRightMenu: true;
        toolbarHideFileName: true;
      };
      embedded: { autostart: "player"; toolbarDocked: "bottom" };
    };
    token?: string;
  };
}

const OPAQUE_ARTIFACT_ID = /^[A-Za-z0-9_-]{8,160}$/;

export function parseArtifactUri(value: string): string | undefined {
  const prefix = "artifact://";
  if (!value.startsWith(prefix)) return undefined;
  const id = value.slice(prefix.length);
  return OPAQUE_ARTIFACT_ID.test(id) ? id : undefined;
}

export function makeArtifactUri(artifactId: string): string {
  if (!OPAQUE_ARTIFACT_ID.test(artifactId)) throw new Error("artifactId 必须是 opaque ID");
  return `artifact://${artifactId}`;
}
