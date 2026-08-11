import type { ReactNode } from "react";
import type { DemoAgent } from "./types.js";

export function AgentComparisonGrid({
  agents,
  children,
  className = "",
  headerScore,
}: {
  agents: DemoAgent[];
  children: (agent: DemoAgent) => ReactNode;
  className?: string;
  headerScore?: (agent: DemoAgent) => number;
}) {
  return <div className={`agent-grid-scroll ${className}`}>
    <div className="agent-grid">
      {agents.map((agent) => <article className={`agent-column tone-${agent.tone}`} key={agent.id}>
        <header className={`agent-column-header ${headerScore ? "has-score" : ""}`}>
          <span className="agent-index">{agent.name.slice(-1)}</span>
          <div><strong>{agent.name}</strong><small>{agent.variant} · {agent.model}</small><em>{agent.runPolicy === "reuse_snapshot" ? "复用历史结果" : "本次重新运行"}</em></div>
          {headerScore
            ? <span className="agent-header-score" title="当前标注动态得分"><b>{headerScore(agent)}</b><small>/ 100</small></span>
            : <i aria-hidden="true" />}
        </header>
        {children(agent)}
      </article>)}
    </div>
  </div>;
}
