import { ArrowLeft, FileCode2, FileText } from "lucide-react";
import { demoArtifacts } from "./mock-data.js";

/** Demo 产物使用独立页面展示，避免继承聊天会话的侧栏预览行为。 */
export function DemoArtifactPage({ artifactId }: { artifactId: string }) {
  const artifact = demoArtifacts.find((candidate) => candidate.id === artifactId);
  if (!artifact) return <main className="demo-artifact-page demo-artifact-missing">
    <strong>找不到这个 Demo 产物</strong>
    <a href="/evaluation/demo/agent-comparison"><ArrowLeft size={14} />返回上下文实验结果</a>
  </main>;

  return <main className="demo-artifact-page">
    <header>
      <a href="/evaluation/demo/agent-comparison"><ArrowLeft size={14} />返回上下文实验结果</a>
      <div>
        <span>DEMO ARTIFACT · STANDALONE PAGE</span>
        <h1>{artifact.name}</h1>
        <p>{artifact.summary}</p>
      </div>
      <em>{artifact.kind === "html" ? <FileCode2 size={14} /> : <FileText size={14} />}{artifact.kind === "html" ? "HTML" : "Markdown"}</em>
    </header>
    <section className={`demo-artifact-content artifact-${artifact.kind}`}>
      {artifact.kind === "html"
        ? <iframe sandbox="" srcDoc={artifact.content} title={artifact.name} />
        : <pre>{artifact.content}</pre>}
    </section>
  </main>;
}
