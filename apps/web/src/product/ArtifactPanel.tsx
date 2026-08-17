import { FileText, X } from "lucide-react";
import { useCallback } from "react";
import { controlApi } from "../api/control-api.js";
import { HtmlPreviewFrame } from "../components/artifacts/HtmlPreviewFrame.js";
import { ErrorState, LoadingState } from "./LoadState.js";
import { useResource } from "./use-resource.js";

export function ArtifactPanel({ fileReferenceId, onClose }: { fileReferenceId: string; onClose: () => void }) {
  const load = useCallback(() => controlApi.filePreview(fileReferenceId), [fileReferenceId]);
  const { state, retry } = useResource(load);

  return <aside className="artifact-panel">
    <header><div><FileText size={15} /><span><strong>{state.phase === "ready" || state.phase === "empty" ? state.data.file.displayName : "产物预览"}</strong><small>安全预览 · {fileReferenceId.slice(0, 14)}…</small></span></div><button aria-label="关闭产物预览" type="button" onClick={onClose}><X size={16} /></button></header>
    <div className="artifact-body">{state.phase === "loading" ? <LoadingState label="正在读取产物" /> : state.phase === "error" ? <ErrorState {...state} retry={retry} /> : <Preview value={state.data} />}</div>
  </aside>;
}

function Preview({ value }: { value: Awaited<ReturnType<typeof controlApi.filePreview>> }) {
  if (value.content.kind === "static_html") return <HtmlPreviewFrame csp={value.content.csp} html={value.content.html} title={value.file.displayName} />;
  if (value.content.kind === "markdown" || value.content.kind === "text") return <pre className="artifact-text">{value.content.kind === "markdown" ? value.content.markdown : value.content.text}</pre>;
  if (value.content.kind === "image") return <img alt={value.file.displayName} src={controlApi.contentUrl(value.file.fileReferenceId)} />;
  if (value.content.kind === "pdf") return <iframe src={controlApi.contentUrl(value.file.fileReferenceId)} title={value.file.displayName} />;
  return <div className="product-state"><FileText size={20} /><strong>暂不支持安全预览</strong><p>该类型未开放下载端点；请让 Agent 转换为 Markdown、静态 HTML、图片或 PDF。</p></div>;
}
