import { Download, FileBox, GraduationCap } from "lucide-react";
import { useCallback } from "react";
import { controlApi } from "../api/control-api.js";
import { ErrorState, LoadingState } from "./LoadState.js";
import { PublishedPreview } from "./PublishedArtifactPanel.js";
import { useResource } from "./use-resource.js";

/** 公开页面只展示匿名预览合同；管理能力继续留在登录后的个人空间。 */
export function PublicArtifactPage({ artifactId }: { artifactId: string }) {
  const load = useCallback(/** Artifact ID 变化时才重建匿名预览请求。 */
    () => controlApi.publicArtifactPreview(artifactId),
    [artifactId],
  );
  const { state, retry } = useResource(load);
  return <main className="product-page">
    <header className="product-nav">
      <a className="product-brand" href="/"><span><GraduationCap size={17} /></span><div><strong>模型幼儿园</strong><small>公开 Artifact</small></div></a>
    </header>
    <section className="product-artifact-detail product-public-artifact">
      {state.phase === "loading" ? <LoadingState label="正在读取 Artifact" /> : state.phase === "error" ? <ErrorState {...state} retry={retry} /> : <>
        <header><div><FileBox size={19} /><span><h1>{state.data.artifact.displayName}</h1><small>任何持有此链接的人均可访问</small></span></div><div>
          <a href={controlApi.publicArtifactContentUrl(artifactId)}><Download size={14} />下载</a>
        </div></header>
        <dl>
          <div><dt>版本</dt><dd>v{state.data.artifact.version}</dd></div>
          <div><dt>类型</dt><dd>{state.data.artifact.kind === "html_bundle" ? "HTML Bundle" : "文件"}</dd></div>
          <div><dt>MIME</dt><dd>{state.data.artifact.primary.mimeType}</dd></div>
          <div><dt>大小</dt><dd>{formatBytes(state.data.artifact.primary.byteLength)}</dd></div>
        </dl>
        <div className="product-artifact-preview"><PublishedPreview
          loadPptxPlayback={controlApi.publicArtifactPptxPlayback}
          value={state.data}
        /></div>
      </>}
    </section>
  </main>;
}

/** 把公开元数据中的字节数格式化为短文本。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
