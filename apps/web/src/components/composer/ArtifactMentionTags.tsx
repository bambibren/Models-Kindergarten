import { FileArchive, FileCode2, FileText, X } from "lucide-react";
import type { ArtifactRecord } from "@kindergarten/contracts";

/** 复用 Composer 的 Artifact 引用标签；展示字段只来自 Remote 返回的当前账号记录。 */
export function ArtifactMentionTags({ artifacts, onRemove }: {
  artifacts: ArtifactRecord[];
  onRemove: (artifactId: string) => void;
}) {
  if (artifacts.length === 0) return null;
  return <div className="composer-mention-tags" aria-label="已引用产物">{artifacts.map(
    (artifact) => <span className="composer-mention-tag" key={artifact.artifactId} title={`${artifact.displayName} · ${artifact.artifactId}`}>
      {artifact.kind === "html_bundle" ? <FileCode2 size={12} /> : artifact.primary.mimeType.startsWith("image/") ? <FileArchive size={12} /> : <FileText size={12} />}
      <strong>{artifact.displayName}</strong><small>{artifact.artifactId.slice(-6)}</small>
      <button aria-label={`移除 ${artifact.displayName}`} type="button" onClick={() => onRemove(artifact.artifactId)}><X size={11} /></button>
    </span>,
  )}</div>;
}
