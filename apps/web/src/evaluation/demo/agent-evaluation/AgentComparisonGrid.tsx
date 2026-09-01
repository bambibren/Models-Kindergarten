import type { ReactNode } from "react";
import type { DemoAgent } from "./types.js";

/** 渲染「AgentComparisonGrid」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function AgentComparisonGrid({
  agents,
  children,
  className = "",
  headerScore,
  headerScoreLabel = "当前标注动态得分",
}: {
  agents: DemoAgent[];
  children: (agent: DemoAgent) => ReactNode;
  className?: string;
  headerScore?: (agent: DemoAgent) => number;
  headerScoreLabel?: string;
}) {
  return <div className={`agent-grid-scroll ${className}`}>
    <div className="agent-grid">
      {agents.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(agent) => <article className={`agent-column tone-${agent.tone}`} key={agent.id}>
        <header className={`agent-column-header ${headerScore ? "has-score" : ""}`}>
          <span className="agent-index">{agent.name.slice(-1)}</span>
          <div><strong>{agent.name}</strong><small>{agent.variant} · {agent.model}</small><em>{agent.runPolicy === "reuse_snapshot" ? "复用历史结果" : "本次重新运行"}</em></div>
          {headerScore
            ? <span className="agent-header-score" title={headerScoreLabel}><b>{headerScore(agent)}</b><small>/ 100</small></span>
            : <i aria-hidden="true" />}
        </header>
        {children(agent)}
      </article>)}
    </div>
  </div>;
}
