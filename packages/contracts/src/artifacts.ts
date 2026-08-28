/** 描述「ArtifactKind」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ArtifactKind = "file" | "html_bundle";
/** 描述「ArtifactState」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ArtifactState = "active" | "archived";

/** 描述「ArtifactBlobRef」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ArtifactBlobRef {
  sha256: string;
  byteLength: number;
  mimeType: string;
}

/** 描述「HtmlBundleManifest」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
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

/** 描述「ArtifactRecord」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
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

/** 描述「ArtifactListResponse」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ArtifactListResponse {
  items: ArtifactRecord[];
}

/** 描述「ArtifactPreviewResponse」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
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

/** 描述「PptxPlaybackResponse」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
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

/** 校验并规范化「parseArtifactUri」输入，非法数据直接返回明确错误。 */
export function parseArtifactUri(value: string): string | undefined {
  const prefix = "artifact://";
  if (!value.startsWith(prefix)) return undefined;
  const id = value.slice(prefix.length);
  return OPAQUE_ARTIFACT_ID.test(id) ? id : undefined;
}

/** 根据已校验输入构建「makeArtifactUri」结果，不额外持有调用方的大对象。 */
export function makeArtifactUri(artifactId: string): string {
  if (!OPAQUE_ARTIFACT_ID.test(artifactId)) throw new Error("artifactId 必须是 opaque ID");
  return `artifact://${artifactId}`;
}
