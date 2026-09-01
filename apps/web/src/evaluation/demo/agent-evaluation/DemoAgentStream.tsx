import { Brain, Braces, ChevronDown, ExternalLink, FileCode2, FileText, Wrench } from "lucide-react";
import type { DemoAgent, DemoEvaluationArtifact } from "./types.js";

/** 渲染「DemoAgentStream」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function DemoAgentStream({ agent, artifacts }: { agent: DemoAgent; artifacts: DemoEvaluationArtifact[] }) {
  return <div className="comparison-agent-stream">
    {agent.stream.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => {
      if (item.type === "context") return <details className="comparison-stream-item context" key={item.id}>
        <summary><Braces size={14} /><div><strong>{item.title}</strong><small>{item.detail}</small></div><span>{item.tokens} tokens</span><ChevronDown size={13} /></summary>
        <pre>{item.raw}</pre>
      </details>;
      if (item.type === "thought") return <details className="comparison-stream-item thought" key={item.id}>
        <summary><Brain size={14} /><div><strong>{item.title}</strong><small>模型推理过程</small></div><span>{item.tokens} tokens</span><ChevronDown size={13} /></summary>
        <p>{item.text}</p>
      </details>;
      if (item.type === "tool") return <details className="comparison-stream-item tool" key={item.id}>
        <summary><Wrench size={14} /><div><strong>{item.name}</strong><small>{item.status === "completed" ? "完成" : "失败"}</small></div><span>{item.tokens} tokens</span><ChevronDown size={13} /></summary>
        <div className="comparison-tool-payload"><span>输入</span><pre>{item.input}</pre><span>输出</span><pre>{item.output}</pre></div>
      </details>;
      const linkedArtifacts = (item.artifactIds ?? []).flatMap((id) => {
        const artifact = artifacts.find((candidate) => candidate.id === id);
        return artifact ? [artifact] : [];
      });
      return <article className="comparison-stream-answer" key={item.id}>
        <p>{item.text}</p>
        {linkedArtifacts.length > 0 && <div className="comparison-artifact-links">
          {linkedArtifacts.map((artifact) => <a
            href={`/evaluation/demo/agent-comparison/artifacts/${encodeURIComponent(artifact.id)}`}
            key={artifact.id}
            rel="noreferrer"
            target="_blank"
          >
            {artifact.kind === "html" ? <FileCode2 size={14} /> : <FileText size={14} />}
            <span><strong>{artifact.name}</strong><small>{artifact.summary}</small></span>
            <ExternalLink size={12} />
          </a>)}
        </div>}
        <small>回答 {item.tokens} tokens</small>
      </article>;
    })}
  </div>;
}
