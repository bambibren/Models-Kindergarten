import type { DemoAgent, ScoreTabId } from "./types.js";

const axes = [
  { id: "understanding", label: "理解能力" },
  { id: "planning", label: "规划能力" },
  { id: "output", label: "输出结果" },
  { id: "execution", label: "执行能力" },
] as const;

const colors = {
  slate: "#c2c5bd",
  blue: "#78a9ff",
  green: "#66c6a0",
} as const;

export function RadarChart({
  agents,
  scoreFor,
}: {
  agents: DemoAgent[];
  scoreFor: (tab: ScoreTabId, agent: DemoAgent) => number;
}) {
  const centerX = 180;
  const centerY = 145;
  const radius = 98;

  return <div className="radar-wrap">
    <svg aria-label="三个 Agent 的综合能力雷达图" className="radar-chart" role="img" viewBox="0 0 360 310">
      {[0.25, 0.5, 0.75, 1].map((level) => <polygon
        className="radar-grid"
        key={level}
        points={axes.map((_, index) => point(index, axes.length, radius * level, centerX, centerY)).join(" ")}
      />)}
      {axes.map((axis, index) => {
        const axisPoint = cartesian(index, axes.length, radius, centerX, centerY);
        const labelPoint = cartesian(index, axes.length, radius + 30, centerX, centerY);
        return <g key={axis.id}>
          <line className="radar-axis" x1={centerX} x2={axisPoint.x} y1={centerY} y2={axisPoint.y} />
          <text className="radar-label" dominantBaseline="middle" textAnchor="middle" x={labelPoint.x} y={labelPoint.y}>{axis.label}</text>
        </g>;
      })}
      {agents.map((agent) => {
        const values = [
          scoreFor("understanding", agent),
          scoreFor("planning", agent),
          scoreFor("output", agent),
          agent.execution.score,
        ];
        const coordinates = values.map((value, index) => cartesian(index, axes.length, radius * value / 100, centerX, centerY));
        const points = coordinates.map((value) => `${value.x},${value.y}`);
        return <g key={agent.id}>
          <polygon fill={colors[agent.tone]} fillOpacity=".09" points={points.join(" ")} stroke={colors[agent.tone]} strokeWidth="2" />
          {coordinates.map((value, index) => <circle cx={value.x} cy={value.y} fill={colors[agent.tone]} key={axes[index]?.id} r="3" />)}
        </g>;
      })}
    </svg>
    <div className="radar-legend">
      {agents.map((agent) => <span key={agent.id}><i style={{ background: colors[agent.tone] }} />{agent.name} · {agent.variant}</span>)}
    </div>
  </div>;
}

function point(index: number, count: number, radius: number, centerX: number, centerY: number): string {
  const value = cartesian(index, count, radius, centerX, centerY);
  return `${value.x},${value.y}`;
}

function cartesian(index: number, count: number, radius: number, centerX: number, centerY: number) {
  const angle = -Math.PI / 2 + index * Math.PI * 2 / count;
  return {
    x: centerX + Math.cos(angle) * radius,
    y: centerY + Math.sin(angle) * radius,
  };
}
