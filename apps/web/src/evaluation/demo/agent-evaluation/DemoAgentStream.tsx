import { Brain, Braces, ChevronDown, ExternalLink, FileCode2, FileText, Wrench } from "lucide-react";
import { ContentRenderer } from "../../../components/chat/ContentRenderer.js";
import type { DemoAgent, DemoAgentStreamItem, DemoEvaluationArtifact } from "./types.js";
import "./comparison-message-stream.css";

type StreamAgent = Pick<DemoAgent, "stream"> | { stream: DemoAgentStreamItem[] };
type StreamArtifact = Pick<DemoEvaluationArtifact, "id" | "name" | "kind" | "summary">;

/** 渲染「DemoAgentStream」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function DemoAgentStream({ agent, artifacts, artifactHref = demoArtifactHref, emptyState }: {
  agent: StreamAgent;
  artifacts: StreamArtifact[];
  artifactHref?: (artifactId: string) => string;
  emptyState?: string | undefined;
}) {
  const hasAnswer = agent.stream.some((item) => item.type === "answer" && item.text.trim().length > 0);
  return <div className="comparison-agent-stream">
    {agent.stream.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => {
      if (item.type === "context") return <details className="comparison-stream-item context" key={item.id}>
        <summary><Braces size={14} /><div><strong>{item.title}</strong><small>{item.detail}</small></div>{item.tokens !== undefined && <span>{item.tokens} tokens</span>}<ChevronDown size={13} /></summary>
        <pre>{item.raw}</pre>
      </details>;
      if (item.type === "thought") return <details className="comparison-stream-item thought" key={item.id}>
        <summary><Brain size={14} /><div><strong>{item.title}</strong><small>模型推理过程</small></div>{item.tokens !== undefined && <span>{item.tokens} tokens</span>}<ChevronDown size={13} /></summary>
        <p>{item.text}</p>
      </details>;
      if (item.type === "tool") return <details className="comparison-stream-item tool" key={item.id}>
        <summary><Wrench size={14} /><div><strong>{item.name}</strong><small>{item.status === "completed" ? "完成" : item.status === "failed" ? "失败" : "执行中"}</small></div>{item.tokens !== undefined && <span>{item.tokens} tokens</span>}<ChevronDown size={13} /></summary>
        <div className="comparison-tool-payload"><span>输入</span><pre>{item.input}</pre><span>输出</span><pre>{item.output}</pre></div>
      </details>;
      const linkedArtifacts = (item.artifactIds ?? []).flatMap((id) => {
        const artifact = artifacts.find((candidate) => candidate.id === id);
        return artifact ? [artifact] : [];
      });
      return <article className="comparison-stream-answer" key={item.id}>
        <ContentRenderer artifactNavigation={{ href: artifactHref }} content={[{ type: "text", text: item.text }]} />
        {linkedArtifacts.length > 0 && <div className="comparison-artifact-links">
          {linkedArtifacts.map((artifact) => <a
            href={artifactHref(artifact.id)}
            key={artifact.id}
            rel="noreferrer"
            target="_blank"
          >
            {artifact.kind === "html" ? <FileCode2 size={14} /> : <FileText size={14} />}
            <span><strong>{artifact.name}</strong><small>{artifact.summary}</small></span>
            <ExternalLink size={12} />
          </a>)}
        </div>}
        {item.tokens !== undefined && <small>回答 {item.tokens} tokens</small>}
      </article>;
    })}
    {!hasAnswer && emptyState && <div className="comparison-stream-empty"><strong>{emptyState}</strong><small>已保留取消前产生的上下文、思考和工具记录。</small></div>}
  </div>;
}

function demoArtifactHref(artifactId: string): string {
  return `/evaluation/demo/agent-comparison/artifacts/${encodeURIComponent(artifactId)}`;
}
