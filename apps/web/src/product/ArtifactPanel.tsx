import type { FileReference } from "@kindergarten/contracts";
import { FileText, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect } from "react";
import { controlApi } from "../api/control-api.js";
import { HtmlPreviewFrame } from "../components/artifacts/HtmlPreviewFrame.js";
import { PptxPreview } from "../components/artifacts/PptxPreview.js";
import { ErrorState, LoadingState } from "./LoadState.js";
import { useResource } from "./use-resource.js";

export function ArtifactPanel({
  fileReferenceId,
  onClose,
  onFileLoaded,
}: {
  fileReferenceId: string;
  onClose: () => void;
  onFileLoaded?: (file: FileReference) => void;
}) {
  const load = useCallback(() => controlApi.filePreview(fileReferenceId), [fileReferenceId]);
  const { state, retry } = useResource(load);
  useEffect(() => {
    if (state.phase === "ready" || state.phase === "empty") onFileLoaded?.(state.data.file);
  }, [onFileLoaded, state]);

  return <aside className="artifact-panel">
    <header>
      <div className="artifact-title"><FileText size={15} /><span><strong>{state.phase === "ready" || state.phase === "empty" ? state.data.file.displayName : "产物预览"}</strong><small>安全预览 · {fileReferenceId.slice(0, 14)}…</small></span></div>
      <div className="artifact-actions">
        <button aria-label="刷新当前预览" disabled={state.phase === "loading"} title="刷新当前预览" type="button" onClick={retry}><RefreshCw size={15} /></button>
        <button aria-label="关闭产物预览" title="关闭产物预览" type="button" onClick={onClose}><X size={16} /></button>
      </div>
    </header>
    <div className="artifact-body">{state.phase === "loading" ? <LoadingState label="正在读取产物" /> : state.phase === "error" ? <ErrorState {...state} retry={retry} /> : <Preview value={state.data} />}</div>
  </aside>;
}

function Preview({ value }: { value: Awaited<ReturnType<typeof controlApi.filePreview>> }) {
  if (value.content.kind === "static_html") return <HtmlPreviewFrame csp={value.content.csp} html={value.content.html} title={value.file.displayName} />;
  if (value.content.kind === "markdown" || value.content.kind === "text") return <pre className="artifact-text">{value.content.kind === "markdown" ? value.content.markdown : value.content.text}</pre>;
  if (value.content.kind === "image") return <img alt={value.file.displayName} src={controlApi.contentUrl(value.file.fileReferenceId)} />;
  if (value.content.kind === "pdf") return <iframe src={controlApi.contentUrl(value.file.fileReferenceId)} title={value.file.displayName} />;
  if (value.content.kind === "pptx") return <PptxPreview contentUrl={controlApi.contentUrl(value.file.fileReferenceId)} title={value.file.displayName} />;
  return <div className="product-state"><FileText size={20} /><strong>暂不支持安全预览</strong><p>该类型未开放下载端点；请让 Agent 转换为 Markdown、静态 HTML、图片或 PDF。</p></div>;
}
