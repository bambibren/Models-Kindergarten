import { Archive, ArrowLeft, Download, FileBox, RotateCcw } from "lucide-react";
import { useCallback, useState } from "react";
import { controlApi } from "../api/control-api.js";
import { ProductNav } from "./ProductNav.js";
import { ErrorState, LoadingState } from "./LoadState.js";
import { PublishedPreview } from "./PublishedArtifactPanel.js";
import { useResource } from "./use-resource.js";

export function ArtifactDetailPage({ artifactId }: { artifactId: string }) {
  const load = useCallback(() => controlApi.artifactPreview(artifactId), [artifactId]);
  const { state, retry } = useResource(load);
  const [busy, setBusy] = useState(false);
  async function toggle() {
    if (state.phase !== "ready" && state.phase !== "empty") return;
    setBusy(true);
    try { await controlApi.setArtifactState(artifactId, state.data.artifact.state === "active" ? "archive" : "restore"); retry(); }
    finally { setBusy(false); }
  }
  return <main className="product-page"><ProductNav active="me" /><section className="product-artifact-detail">
    <a className="product-artifact-back" href="/me?tab=artifacts"><ArrowLeft size={14} />返回产物列表</a>
    {state.phase === "loading" ? <LoadingState label="正在读取 Artifact" /> : state.phase === "error" ? <ErrorState {...state} retry={retry} /> : <>
      <header><div><FileBox size={19} /><span><h1>{state.data.artifact.displayName}</h1><small>v{state.data.artifact.version ?? 1} · {state.data.artifact.artifactId} · {state.data.artifact.kind}</small></span></div><div>
        <a href={controlApi.artifactContentUrl(artifactId)}><Download size={14} />下载</a>
        <button disabled={busy} type="button" onClick={() => void toggle()}>{state.data.artifact.state === "active" ? <Archive size={14} /> : <RotateCcw size={14} />}{state.data.artifact.state === "active" ? "归档" : "恢复"}</button>
      </div></header>
      <dl><div><dt>版本</dt><dd>v{state.data.artifact.version ?? 1}</dd></div><div><dt>可回滚</dt><dd>{Math.max(0, (state.data.artifact.revisions?.length ?? 1) - 1)} 步</dd></div><div><dt>来源 Session</dt><dd>{state.data.artifact.sourceSessionId}</dd></div><div><dt>来源 Turn</dt><dd>{state.data.artifact.sourceTurnId}</dd></div><div><dt>MIME</dt><dd>{state.data.artifact.primary.mimeType}</dd></div><div><dt>SHA-256</dt><dd>{state.data.artifact.primary.sha256}</dd></div></dl>
      <div className="product-artifact-preview"><PublishedPreview value={state.data} /></div>
    </>}
  </section></main>;
}
