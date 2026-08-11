import {
  Brain,
  Braces,
  ChevronDown,
  FileCode2,
  FileText,
  FlaskConical,
  LoaderCircle,
  Server,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import { useState } from "react";
import { Streamdown } from "streamdown";
import { cjk } from "@streamdown/cjk";
import type { DemoArtifact, DemoStreamItem } from "../demo-types.js";

export function DemoChatStream({
  items,
  artifacts,
  onOpenArtifact,
  compact = false,
}: {
  items: DemoStreamItem[];
  artifacts: DemoArtifact[];
  onOpenArtifact?: (artifact: DemoArtifact) => void;
  compact?: boolean;
}) {
  return <div className={`mk-demo-chat-stream ${compact ? "compact" : ""}`}>
    {items.map((item) => {
      if (item.type === "user") return <article className="mk-demo-user-turn" key={item.id}>
        <p>{item.text}</p><small>输入约 {item.inputTokens} tokens</small>
      </article>;
      if (item.type === "context") return <ContextItem item={item} key={item.id} compact={compact} />;
      if (item.type === "thought") return <details className="mk-demo-activity" key={item.id}>
        <summary><Brain size={14} /><strong>{item.title}</strong><small>推理约 {item.tokens} tokens</small><ChevronDown size={13} /></summary>
        <p>{item.text}</p>
      </details>;
      if (item.type === "mcp_boundary") return <details className="mk-demo-activity mk-demo-tool" key={item.id}>
        <summary><ShieldCheck size={14} /><strong>MCP 能力边界 · {item.agentName}</strong><small>{item.allowedMcps.length} 个已注册 · 排除 {item.excludedCount} 个</small><ChevronDown size={13} /></summary>
        <div className="mk-demo-tool-body mk-demo-mcp-boundary-body"><p>本轮只向模型暴露以下远程 MCP 的 Tool Schema；执行器还会按同一 allowlist 二次校验调用。</p>{item.allowedMcps.length > 0 ? <ul>{item.allowedMcps.map((mcp) => <li key={mcp.id}><Server size={12} /><span><strong>{mcp.name}</strong><small>{mcp.toolCount} 个 Tools · {mcp.id}</small></span></li>)}</ul> : <strong className="mk-demo-mcp-empty">当前 Agent 未配置可用 MCP</strong>}<small>另外 {item.excludedCount} 个已安装 MCP 未注册，模型不可见也不可调用。</small></div>
      </details>;
      if (item.type === "tool") return <details className="mk-demo-activity mk-demo-tool" key={item.id}>
        <summary>{item.status === "in_progress" ? <LoaderCircle className="mk-demo-spin" size={14} /> : <Wrench size={14} />}<strong>{item.name}</strong><small>{item.status === "completed" ? "完成" : item.status === "failed" ? "失败" : "进行中"}{item.tokens > 0 ? ` · ${item.tokens} tokens` : ""}</small><ChevronDown size={13} /></summary>
        <div className="mk-demo-tool-body">{item.source === "mcp" && <div className="mk-demo-tool-source"><Server size={12} /><span><strong>{item.serverName}</strong><small>Remote MCP · {item.toolCallId}</small></span></div>}<span>输入</span><pre>{item.input}</pre><span>输出</span><pre>{item.output}</pre></div>
      </details>;
      const linkedArtifacts = (item.artifactIds ?? []).flatMap((id) => {
        const artifact = artifacts.find((candidate) => candidate.id === id);
        return artifact ? [artifact] : [];
      });
      return <article className="mk-demo-assistant-turn" key={item.id}>
        <Streamdown plugins={{ cjk }}>{item.markdown}</Streamdown>
        {linkedArtifacts.length > 0 && <div className="mk-demo-artifact-links">
          {linkedArtifacts.map((artifact) => <button key={artifact.id} type="button" onClick={() => onOpenArtifact?.(artifact)}>
            {artifact.kind === "markdown" ? <FileText size={15} /> : <FileCode2 size={15} />}
            <span><strong>{artifact.name}</strong><small>{artifact.kind === "markdown" ? "Markdown 产物" : "静态 HTML 产物"}</small></span>
          </button>)}
        </div>}
        <small className="mk-demo-output-tokens">回答约 {item.outputTokens} tokens</small>
      </article>;
    })}
  </div>;
}

function ContextItem({ item, compact }: {
  item: Extract<DemoStreamItem, { type: "context" }>;
  compact: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const query = new URLSearchParams({ mode: "turn", turnId: item.turnId });
  return <section className="mk-demo-context-item">
    <div className="mk-demo-context-heading">
      <div className="mk-demo-context-title-row">
        <button aria-expanded={expanded} className="mk-demo-context-toggle" type="button" onClick={() => setExpanded((value) => !value)}>
          <Braces size={14} /><strong>上下文提要</strong><small>{item.items.length} 项 · 约 {item.totalTokens} tokens</small><ChevronDown className={expanded ? "expanded" : ""} size={13} />
        </button>
        {item.experimentEntry && !compact && <a href={`/demo/context-lab?${query.toString()}`}><FlaskConical size={13} />进行上下文编辑对比实验</a>}
      </div>
      {expanded && <div className="mk-demo-context-panel">
        {item.items.map((contextItem) => <details key={contextItem.id}>
          <summary><span>{contextItem.title}</span><small>{contextItem.detail} · 约 {contextItem.tokens} tokens</small><ChevronDown size={12} /></summary>
          <pre>{contextItem.raw}</pre>
        </details>)}
      </div>}
    </div>
  </section>;
}
