import { FileCode2, FileText, X } from "lucide-react";
import { Streamdown } from "streamdown";
import { cjk } from "@streamdown/cjk";
import type { DemoArtifact } from "../demo-types.js";

export function ArtifactPanel({ artifact, onClose }: { artifact: DemoArtifact; onClose: () => void }) {
  return <section className="mk-demo-artifact-panel">
    <header>
      <span>{artifact.kind === "markdown" ? <FileText size={15} /> : <FileCode2 size={15} />}<strong title={artifact.name}>{artifact.name}</strong></span>
      <button aria-label="关闭产物" type="button" onClick={onClose}><X size={16} /></button>
    </header>
    <div className="mk-demo-artifact-body">
      {artifact.kind === "markdown"
        ? <article className="mk-demo-markdown-preview"><Streamdown plugins={{ cjk }}>{artifact.content}</Streamdown></article>
        : <iframe sandbox="" srcDoc={artifact.content} title={`${artifact.name} 静态预览`} />}
    </div>
  </section>;
}
