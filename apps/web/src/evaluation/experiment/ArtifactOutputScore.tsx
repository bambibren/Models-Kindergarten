import { ExternalLink, FileBox } from "lucide-react";
import type { SessionHistoryEntry } from "../../api/control-api.js";

export interface OutputArtifactRef {
  artifactId: string;
  label: string;
  mimeType?: string;
}

const ARTIFACT_OUTPUT_TOOLS = new Set(["publish_artifact", "publish_artifact_version", "rollback_artifact"]);

/** 从真实工具结果提取本 Turn 已发布产物；读取、提及或失败的 Artifact 都不进入输出评分。 */
export function publishedArtifactRefs(entries: SessionHistoryEntry[]): OutputArtifactRef[] {
  const found = entries.flatMap((entry) => {
    if (entry.type !== "tool_call" || entry.status !== "completed" ||
      (entry.outcomeStatus !== undefined && entry.outcomeStatus !== "success") || !ARTIFACT_OUTPUT_TOOLS.has(entry.name)) return [];
    return entry.content.flatMap((item) => {
      if (item.type !== "content" || item.content.type !== "resource_link" || !item.content.uri.startsWith("artifact://")) return [];
      const artifactId = item.content.uri.slice("artifact://".length);
      if (!artifactId) return [];
      return [{
        artifactId,
        label: item.content.title ?? item.content.name,
        ...(item.content.mimeType ? { mimeType: item.content.mimeType } : {}),
      } satisfies OutputArtifactRef];
    });
  });
  return [...new Map(found.map((artifact) => [artifact.artifactId, artifact])).values()];
}

/** 有产物的 lane 不再暴露回答文本标注，只展示正式 Artifact 链接和一个总计 100 分的人工分。 */
export function ArtifactOutputScore({ artifacts, score, variantId, onChange }: {
  artifacts: OutputArtifactRef[];
  score: number;
  variantId: string;
  onChange: (score: number) => void;
}) {
  const update = (value: string) => onChange(Math.max(0, Math.min(100, Number.parseInt(value, 10) || 0)));
  return <div className="artifact-output-score">
    <div className="artifact-output-links">{artifacts.map((artifact) => <a href={`/artifacts/${encodeURIComponent(artifact.artifactId)}`} key={artifact.artifactId} rel="noreferrer" target="_blank">
      <FileBox size={16} /><span><strong>{artifact.label}</strong><small>{artifact.mimeType ?? "Artifact"} · {artifact.artifactId}</small></span><ExternalLink size={13} />
    </a>)}</div>
    <label className="artifact-score-control" htmlFor={`artifact-score-${variantId}`}><span>产物评分</span><strong>{score}</strong><small>/ 100</small></label>
    <div className="artifact-score-inputs"><input aria-label={`Test ${variantId} 产物评分滑块`} id={`artifact-score-${variantId}`} max="100" min="0" step="1" type="range" value={score} onChange={(event) => update(event.currentTarget.value)} /><input aria-label={`Test ${variantId} 产物评分`} max="100" min="0" step="1" type="number" value={score} onChange={(event) => update(event.currentTarget.value)} /></div>
  </div>;
}
