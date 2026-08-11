import { Brain, Braces, ChevronDown, Wrench } from "lucide-react";
import type { DemoAgent } from "./types.js";

export function DemoAgentStream({ agent }: { agent: DemoAgent }) {
  return <div className="comparison-agent-stream">
    {agent.stream.map((item) => {
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
      return <article className="comparison-stream-answer" key={item.id}><p>{item.text}</p><small>回答 {item.tokens} tokens</small></article>;
    })}
  </div>;
}
