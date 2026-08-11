import {
  ArrowLeft,
  BarChart3,
  BookmarkCheck,
  BookmarkPlus,
  Check,
  CircleDot,
  Clock3,
  Highlighter,
  MessageSquareText,
  MousePointer2,
  Route,
  Wrench,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { AgentComparisonGrid } from "./AgentComparisonGrid.js";
import { AnnotationTabs } from "./AnnotationTabs.js";
import { ComparisonHistoryRail } from "./ComparisonHistoryRail.js";
import { DemoAgentStream } from "./DemoAgentStream.js";
import { MarkerText } from "./MarkerText.js";
import { RadarChart } from "./RadarChart.js";
import { demoAgents, demoTask, savedComparisons } from "./mock-data.js";
import type { DemoSavedComparison } from "./types.js";
import type {
  AgentId,
  AnnotationTabId,
  DemoAgent,
  MarkColor,
  ScoreTabId,
  TextMark,
  ViewMode,
} from "./types.js";
import "./agent-evaluation-demo.css";

export function AgentEvaluationDemoPage() {
  const query = useMemo(() => new URLSearchParams(location.search), []);
  const linkedComparisonId = query.get("comparisonId");
  const [comparisonRecords, setComparisonRecords] = useState<DemoSavedComparison[]>(savedComparisons);
  const [selectedComparisonId, setSelectedComparisonId] = useState<string | null>(linkedComparisonId);
  const [saveState, setSaveState] = useState<"unsaved" | "saved">(linkedComparisonId ? "saved" : "unsaved");
  const [mode, setMode] = useState<ViewMode>("answer");
  const [activeTab, setActiveTab] = useState<AnnotationTabId>("understanding");
  const [selectedRequirements, setSelectedRequirements] = useState<string[]>([]);
  const [hasOtherRequirement, setHasOtherRequirement] = useState(false);
  const [listedRequirementsWeight, setListedRequirementsWeight] = useState(80);
  const [planMarks, setPlanMarks] = useState<Record<string, MarkColor>>({});
  const [textMarks, setTextMarks] = useState<TextMark[]>([]);
  const [completedTabs, setCompletedTabs] = useState<Partial<Record<ScoreTabId, boolean>>>({});

  function completeTab(tab: ScoreTabId): void {
    setCompletedTabs((current) => current[tab] ? current : { ...current, [tab]: true });
  }

  function toggleRequirement(requirementId: string): void {
    completeTab("understanding");
    setSelectedRequirements((current) => current.includes(requirementId)
      ? current.filter((item) => item !== requirementId)
      : [...current, requirementId]);
  }

  function toggleOtherRequirement(): void {
    completeTab("understanding");
    setHasOtherRequirement((current) => !current);
  }

  function togglePlanMark(stepId: string, color: MarkColor): void {
    completeTab("planning");
    setPlanMarks((current) => {
      const next = { ...current };
      if (next[stepId] === color) delete next[stepId];
      else next[stepId] = color;
      return next;
    });
  }

  function setAgentTextMarks(agentId: AgentId, marks: TextMark[]): void {
    completeTab("output");
    setTextMarks((current) => [
      ...current.filter((mark) => mark.agentId !== agentId),
      ...marks,
    ]);
  }

  function scoreFor(tab: ScoreTabId, agentId: AgentId): number {
    const agent = demoAgents.find((item) => item.id === agentId);
    if (!agent) return 100;
    if (tab === "understanding") return understandingScore(agent, selectedRequirements, hasOtherRequirement, listedRequirementsWeight);
    if (tab === "planning") return planningScore(agent, planMarks);
    return outputMarkScore(agent, textMarks).score;
  }

  function saveComparison(): void {
    if (saveState === "saved") return;
    const record: DemoSavedComparison = {
      id: "cmp-demo-current",
      title: "本次上下文策略对照",
      createdAt: "08-10 刚刚",
      variantCount: demoAgents.length,
    };
    setComparisonRecords((current) => [record, ...current]);
    setSelectedComparisonId(record.id);
    setSaveState("saved");
  }

  return <div className="comparison-demo-shell">
    <ComparisonHistoryRail records={comparisonRecords} selectedId={selectedComparisonId} />
    <main className="agent-evaluation-demo">
    <header className="demo-header">
      <button aria-label="返回" className="demo-back" onClick={() => history.back()} type="button"><ArrowLeft size={17} /></button>
      <div className="demo-title"><span>MODEL CONTEXT · COMPARISON</span><h1>上下文对比实验结果</h1></div>
      <button className={`comparison-save ${saveState}`} disabled={saveState === "saved"} type="button" onClick={saveComparison}>{saveState === "saved" ? <BookmarkCheck size={14} /> : <BookmarkPlus size={14} />}{saveState === "saved" ? "已保存本次结果" : "保存本次对照实验结果"}</button>
    </header>

    <section className="task-panel">
      <div className="task-label"><span>USER TASK</span><strong>{demoTask.title}</strong></div>
      <p>{demoTask.prompt}</p>
      <div className="mode-switch" aria-label="页面模式">
        <button className={mode === "answer" ? "active" : ""} onClick={() => setMode("answer")} type="button"><MessageSquareText size={14} />回答模式</button>
        <button className={mode === "annotation" ? "active" : ""} onClick={() => setMode("annotation")} type="button"><Highlighter size={14} />标注模式</button>
      </div>
    </section>

    {mode === "answer"
      ? <AnswerMode />
      : <section className="annotation-mode">
        <AnnotationTabs active={activeTab} completed={completedTabs} onChange={setActiveTab} />
        <div className="annotation-context">
          <span><MousePointer2 size={12} />理解、规划和输出由人工标注</span>
          <span>执行能力自动完成 · 未标注模块默认 100</span>
        </div>
        {activeTab === "understanding" && <UnderstandingPanel
          hasOtherRequirement={hasOtherRequirement}
          listedRequirementsWeight={listedRequirementsWeight}
          onOtherRequirementToggle={toggleOtherRequirement}
          onWeightChange={(value) => {
            completeTab("understanding");
            setListedRequirementsWeight(value);
          }}
          selectedRequirements={selectedRequirements}
          onToggle={toggleRequirement}
        />}
        {activeTab === "planning" && <PlanningPanel
          marks={planMarks}
          onMark={togglePlanMark}
        />}
        {activeTab === "output" && <OutputPanel
          marks={textMarks}
          onMarksChange={setAgentTextMarks}
        />}
        {activeTab === "execution" && <ExecutionPanel />}
        {activeTab === "summary" && <SummaryPanel scoreFor={scoreFor} />}
      </section>}
    </main>
  </div>;
}

function AnswerMode() {
  return <section className="demo-section">
    <SectionHeading icon={<MessageSquareText size={17} />} title="Agent回答对比" detail="每栏按上下文、思考、工具与回答的原始顺序投影；历史版本不会重新运行。" />
    <AgentComparisonGrid agents={demoAgents} className="answer-grid">
      {(agent) => <DemoAgentStream agent={agent} />}
    </AgentComparisonGrid>
  </section>;
}

function UnderstandingPanel({
  hasOtherRequirement,
  listedRequirementsWeight,
  selectedRequirements,
  onOtherRequirementToggle,
  onToggle,
  onWeightChange,
}: {
  hasOtherRequirement: boolean;
  listedRequirementsWeight: number;
  selectedRequirements: string[];
  onOtherRequirementToggle: () => void;
  onToggle: (requirementId: string) => void;
  onWeightChange: (value: number) => void;
}) {
  const hasStarted = selectedRequirements.length > 0 || hasOtherRequirement;
  return <section className="tab-panel understanding-panel" role="tabpanel">
    <div className="understanding-workspace">
      <SectionHeading icon={<Check size={17} />} title="需求理解能力 打分" detail="上下文与三个 Agent 思考结果合并去重后，只需要人工标注一次。" />
      <div className="requirement-pool">
        <header><div><span>待标注 LIST</span><strong>请选出您真正的需求</strong></div><small>{selectedRequirements.length}{hasOtherRequirement ? " + 其他" : ""} 已选</small></header>
        <div className="requirement-pool-list">
          {demoTask.requirements.map((requirement) => {
            const selected = selectedRequirements.includes(requirement.id);
            return <button className={selected ? "selected" : ""} key={requirement.id} onClick={() => onToggle(requirement.id)} type="button">
              <span className="pool-check">{selected && <Check size={12} />}</span>
              <span className="pool-content">
                <strong className="pool-title">{requirement.label}</strong>
                <small className="pool-source">来源：{requirement.sources.join(" · ")}</small>
              </span>
            </button>;
          })}
        </div>
        <div className={`other-requirement ${hasOtherRequirement ? "selected" : ""}`}>
          <button className="other-requirement-toggle" onClick={onOtherRequirementToggle} type="button">
            <span className="pool-check">{hasOtherRequirement && <Check size={11} />}</span>
            <span className="pool-content"><strong className="pool-title">其他需求</strong><small className="pool-source">当前合并列表未覆盖的真实需求</small></span>
          </button>
          {hasOtherRequirement && <div className="other-requirement-controls">
            <label>
              <span><strong>已列需求合计权重 {listedRequirementsWeight}%</strong><small>其他需求占 {100 - listedRequirementsWeight}%</small></span>
              <input
                aria-label="已列需求权重"
                max="100"
                min="0"
                onChange={(event) => onWeightChange(Number(event.target.value))}
                type="range"
                value={listedRequirementsWeight}
              />
              <span className="weight-scale"><i>0%</i><i>100%</i></span>
            </label>
          </div>}
        </div>
      </div>
      <div className="mapping-heading"><span>AGENT REQUIREMENT MAPPING</span><strong>Agent 真实需求命中率 对比</strong><p>左侧选中需求后，对应命中与标题得分实时更新。</p></div>
      <AgentComparisonGrid
        agents={demoAgents}
        className="understanding-grid"
        headerScore={(agent) => understandingScore(agent, selectedRequirements, hasOtherRequirement, listedRequirementsWeight)}
      >
        {(agent) => <div className="annotation-column-body" title={hasStarted ? `命中 ${understandingMatchCount(agent, selectedRequirements)} / ${demoTask.requirements.length}` : "尚未开始标注，显示默认分"}>
          <div className="agent-understanding-list">
            {agent.understandingPoints.map((point) => {
              const matched = selectedRequirements.includes(point.requirementId);
              return <div className={matched ? "matched" : ""} key={point.id}>
                <span>{matched ? <Check size={10} /> : <X size={10} />}</span><p>{point.text}</p>
              </div>;
            })}
          </div>
        </div>}
      </AgentComparisonGrid>
    </div>
  </section>;
}

function PlanningPanel({
  marks,
  onMark,
}: {
  marks: Record<string, MarkColor>;
  onMark: (stepId: string, color: MarkColor) => void;
}) {
  return <section className="tab-panel" role="tabpanel">
    <SectionHeading icon={<Route size={17} />} title="Workflow 规划能力 打分" detail="点击步骤右侧色点添加或取消标记，颜色含义暂不预设。" />
    <AgentComparisonGrid agents={demoAgents} headerScore={(agent) => planningScore(agent, marks)}>
      {(agent) => <div className="annotation-column-body">
        <div className="plan-flow">
          {agent.plan.map((step, index) => <div className={`plan-step ${marks[step.id] ? `marked-${marks[step.id]}` : ""}`} key={step.id}>
            <span className="plan-number">{String(index + 1).padStart(2, "0")}</span>
            <div><strong>{step.title}</strong><p>{step.detail}</p></div>
            <div className="plan-marker-actions">
              <button aria-label="蓝色标记" className="blue" onClick={() => onMark(step.id, "blue")} type="button" />
              <button aria-label="红色标记" className="red" onClick={() => onMark(step.id, "red")} type="button" />
            </div>
          </div>)}
        </div>
      </div>}
    </AgentComparisonGrid>
  </section>;
}

function OutputPanel({
  marks,
  onMarksChange,
}: {
  marks: TextMark[];
  onMarksChange: (agentId: AgentId, marks: TextMark[]) => void;
}) {
  return <section className="tab-panel" role="tabpanel">
    <SectionHeading icon={<Highlighter size={17} />} title="最终有效输出结果 标注" detail="拖选回答中的任意文本，使用红色或蓝色马克笔；点击已有标注可改色或删除。" />
    <AgentComparisonGrid agents={demoAgents} headerScore={(agent) => outputMarkScore(agent, marks).score}>
      {(agent) => {
        const agentMarks = marks.filter((mark) => mark.agentId === agent.id);
        return <div className="annotation-column-body">
          <MarkerText
            agentId={agent.id}
            marks={agentMarks}
            onChange={(next) => onMarksChange(agent.id, next)}
            sections={agent.answerSections}
          />
        </div>;
      }}
    </AgentComparisonGrid>
  </section>;
}

function SummaryPanel({ scoreFor }: { scoreFor: (tab: ScoreTabId, agentId: AgentId) => number }) {
  return <section className="summary-panel" role="tabpanel">
    <div className="summary-grid">
      <div className="summary-chart-card">
        <SectionHeading icon={<BarChart3 size={17} />} title="综合能力分布" detail="未填写的人工模块按默认满分展示。" />
        <RadarChart agents={demoAgents} scoreFor={(tab, agent) => scoreFor(tab, agent.id)} />
      </div>
      <div className="score-ledger">
        <div className="ledger-heading"><span>SCORE LEDGER</span><strong>四维评分</strong></div>
        {demoAgents.map((agent) => <div className="ledger-row" key={agent.id}>
          <div><strong>{agent.name}</strong><small>{agent.variant}</small></div>
          <span>{scoreFor("understanding", agent.id)}<small>理解</small></span>
          <span>{scoreFor("planning", agent.id)}<small>规划</small></span>
          <span>{scoreFor("output", agent.id)}<small>输出</small></span>
          <span>{agent.execution.score}<small>执行</small></span>
        </div>)}
      </div>
    </div>

  </section>;
}

function ExecutionPanel() {
  return <section className="execution-panel" role="tabpanel">
    <SectionHeading icon={<Wrench size={17} />} title="执行能力" detail="根据 Runtime Trace 自动生成，不需要人工标注。" />
    <div className="execution-grid">
      {demoAgents.map((agent) => <article className={`execution-card tone-${agent.tone}`} key={agent.id}>
        <header><div><span>{agent.name}</span><strong>{agent.variant}</strong></div><b>{agent.execution.score}</b></header>
        <div className="execution-metrics">
          <span><Clock3 size={13} /><strong>{agent.execution.duration}</strong><small>总耗时</small></span>
          <span><CircleDot size={13} /><strong>{agent.execution.modelRounds}</strong><small>Rounds</small></span>
          <span><Wrench size={13} /><strong>{agent.execution.toolCalls}</strong><small>Tools</small></span>
          <span><MessageSquareText size={13} /><strong>{agent.execution.outputTokens}</strong><small>Tokens</small></span>
        </div>
      </article>)}
    </div>
  </section>;
}

function SectionHeading({ icon, title, detail }: { icon: React.ReactNode; title: string; detail: string }) {
  return <div className="demo-section-heading">{icon}<div><h2>{title}</h2><p>{detail}</p></div></div>;
}

function understandingScore(
  agent: DemoAgent,
  selectedRequirements: string[],
  hasOtherRequirement: boolean,
  listedRequirementsWeight: number,
): number {
  if (selectedRequirements.length === 0 && !hasOtherRequirement) return 100;
  const availableWeight = hasOtherRequirement ? listedRequirementsWeight : 100;
  return Math.round(understandingMatchCount(agent, selectedRequirements) / demoTask.requirements.length * availableWeight);
}

function understandingMatchCount(agent: DemoAgent, selectedRequirements: string[]): number {
  const understood = new Set(agent.understandingPoints.map((point) => point.requirementId));
  return selectedRequirements.filter((requirementId) => understood.has(requirementId)).length;
}

function planningScore(agent: DemoAgent, marks: Record<string, MarkColor>): number {
  const selected = agent.plan.flatMap((step) => marks[step.id] ? [marks[step.id]] : []);
  if (selected.length === 0) return 100;
  const weighted = selected.reduce((sum, color) => sum + (color === "red" ? 1 : .5), 0);
  return Math.round(weighted / agent.plan.length * 100);
}

function outputMarkScore(agent: DemoAgent, marks: TextMark[]): {
  score: number;
  redPercent: number;
  bluePercent: number;
  started: boolean;
} {
  const agentMarks = marks.filter((mark) => mark.agentId === agent.id);
  if (agentMarks.length === 0) return { score: 100, redPercent: 0, bluePercent: 0, started: false };
  const totalCharacters = agent.answerSections.reduce((sum, section) => sum + effectiveCharacters(section.text), 0);
  let redCharacters = 0;
  let blueCharacters = 0;
  for (const mark of agentMarks) {
    const section = agent.answerSections.find((item) => item.id === mark.sectionId);
    if (!section) continue;
    const characters = effectiveCharacters(section.text.slice(mark.start, mark.end));
    if (mark.color === "red") redCharacters += characters;
    else blueCharacters += characters;
  }
  const redPercent = Math.round(redCharacters / totalCharacters * 100);
  const bluePercent = Math.round(blueCharacters / totalCharacters * 50);
  return {
    score: Math.min(100, redPercent + bluePercent),
    redPercent,
    bluePercent,
    started: true,
  };
}

function effectiveCharacters(value: string): number {
  return value.replace(/\s/g, "").length;
}
