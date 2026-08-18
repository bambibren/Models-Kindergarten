import { Download, FileCode2, FileText, RefreshCw, X } from "lucide-react";
import { useCallback } from "react";
import { controlApi } from "../api/control-api.js";
import { HtmlPreviewFrame } from "../components/artifacts/HtmlPreviewFrame.js";
import { PptxPreview } from "../components/artifacts/PptxPreview.js";
import { ErrorState, LoadingState } from "./LoadState.js";
import { useResource } from "./use-resource.js";

export function PublishedArtifactPanel({ artifactId, onClose }: { artifactId: string; onClose: () => void }) {
  const load = useCallback(() => controlApi.artifactPreview(artifactId), [artifactId]);
  const { state, retry } = useResource(load);
  const value = state.phase === "ready" || state.phase === "empty" ? state.data : undefined;
  return <aside className="artifact-panel">
    <header>
      <div className="artifact-title">{value?.artifact.kind === "html_bundle" ? <FileCode2 size={15} /> : <FileText size={15} />}<span><strong>{value?.artifact.displayName ?? "Artifact 预览"}</strong><small>{value ? `v${value.artifact.version ?? 1} · ` : ""}{value?.artifact.kind === "html_bundle" ? "HTML Bundle" : value?.artifact.primary.mimeType ?? "正在读取"} · {artifactId.slice(-10)}</small></span></div>
      <div className="artifact-actions">
        <a aria-label="下载 Artifact" href={controlApi.artifactContentUrl(artifactId)} title="下载 Artifact"><Download size={15} /></a>
        <button aria-label="刷新当前预览" disabled={state.phase === "loading"} title="刷新当前预览" type="button" onClick={retry}><RefreshCw size={15} /></button>
        <button aria-label="关闭产物预览" title="关闭产物预览" type="button" onClick={onClose}><X size={16} /></button>
      </div>
    </header>
    <div className="artifact-body">{state.phase === "loading" ? <LoadingState label="正在读取 Artifact" /> : state.phase === "error" ? <ErrorState {...state} retry={retry} /> : <PublishedPreview value={state.data} />}</div>
  </aside>;
}

export function PublishedPreview({ value }: { value: Awaited<ReturnType<typeof controlApi.artifactPreview>> }) {
  if (value.content.kind === "static_html") return <HtmlPreviewFrame csp={value.content.csp} html={value.content.html} title={value.artifact.displayName} />;
  if (value.content.kind === "markdown" || value.content.kind === "text") return <pre className="artifact-text">{value.content.kind === "markdown" ? value.content.markdown : value.content.text}</pre>;
  if (value.content.kind === "image") return <img alt={value.artifact.displayName} src={value.content.contentUrl} />;
  if (value.content.kind === "pdf") return <iframe src={value.content.contentUrl} title={value.artifact.displayName} />;
  if (value.content.kind === "pptx") return <PptxPreview
    contentUrl={value.content.contentUrl}
    title={value.artifact.displayName}
    loadPlayback={() => controlApi.artifactPptxPlayback(value.artifact.artifactId)}
  />;
  return <div className="product-state"><FileText size={20} /><strong>该格式仅支持下载</strong><a href={value.content.contentUrl}>下载 Artifact</a></div>;
}
