import {
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  BrainCircuit,
  BookmarkCheck,
  BookmarkPlus,
  Check,
  CheckCircle2,
  CircleDot,
  Clock3,
  Highlighter,
  MessageSquareText,
  MousePointer2,
  Route,
  TerminalSquare,
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
import { demoAgents, demoArtifacts, demoTask, savedComparisons } from "./mock-data.js";
import type { DemoSavedComparison } from "./types.js";
import type {
  AgentId,
  AnnotationTabId,
  DemoAgent,
  MarkColor,
  ScoreTabId,
  TextMark,
} from "./types.js";
import "./agent-evaluation-demo.css";

/** 渲染「AgentEvaluationDemoPage」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function AgentEvaluationDemoPage() {
  const query = useMemo(/** 缓存「query」的派生计算，依赖变化时重新生成以避免陈旧闭包。 */
() => new URLSearchParams(location.search), []);
  const linkedComparisonId = query.get("comparisonId");
  const [comparisonRecords, setComparisonRecords] = useState<DemoSavedComparison[]>(savedComparisons);
  const [selectedComparisonId, setSelectedComparisonId] = useState<string | null>(linkedComparisonId);
  const [saveState, setSaveState] = useState<"unsaved" | "saved">(linkedComparisonId ? "saved" : "unsaved");
  const [activeTab, setActiveTab] = useState<AnnotationTabId>("answer");
  const [selectedRequirements, setSelectedRequirements] = useState<string[]>([]);
  const [hasOtherRequirement, setHasOtherRequirement] = useState(false);
  const [listedRequirementsWeight, setListedRequirementsWeight] = useState(80);
  const [planMarks, setPlanMarks] = useState<Record<string, MarkColor>>({});
  const [textMarks, setTextMarks] = useState<TextMark[]>([]);
  const [completedTabs, setCompletedTabs] = useState<Partial<Record<ScoreTabId, boolean>>>({});

  /** 执行「completeTab」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function completeTab(tab: ScoreTabId): void {
    setCompletedTabs(/** 执行「completeTab」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(current) => current[tab] ? current : { ...current, [tab]: true });
  }

  /** 根据已校验输入构建「toggleRequirement」结果，不额外持有调用方的大对象。 */
function toggleRequirement(requirementId: string): void {
    completeTab("understanding");
    setSelectedRequirements(/** 根据已校验输入构建「toggleRequirement」结果，不额外持有调用方的大对象。 */
(current) => current.includes(requirementId)
      ? current.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item !== requirementId)
      : [...current, requirementId]);
  }

  /** 根据已校验输入构建「toggleOtherRequirement」结果，不额外持有调用方的大对象。 */
function toggleOtherRequirement(): void {
    completeTab("understanding");
    setHasOtherRequirement(/** 根据已校验输入构建「toggleOtherRequirement」结果，不额外持有调用方的大对象。 */
(current) => !current);
  }

  /** 根据已校验输入构建「togglePlanMark」结果，不额外持有调用方的大对象。 */
function togglePlanMark(stepId: string, color: MarkColor): void {
    completeTab("planning");
    setPlanMarks(/** 根据已校验输入构建「togglePlanMark」结果，不额外持有调用方的大对象。 */
(current) => {
      const next = { ...current };
      if (next[stepId] === color) delete next[stepId];
      else next[stepId] = color;
      return next;
    });
  }

  /** 更新「setAgentTextMarks」对应状态，并保持写入顺序、原子性与容量约束。 */
function setAgentTextMarks(agentId: AgentId, marks: TextMark[]): void {
    completeTab("output");
    setTextMarks(/** 更新「setAgentTextMarks」对应状态，并保持写入顺序、原子性与容量约束。 */
(current) => [
      ...current.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(mark) => mark.agentId !== agentId),
      ...marks,
    ]);
  }

  /** 执行「scoreFor」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function scoreFor(tab: ScoreTabId, agentId: AgentId): number {
    const agent = demoAgents.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.id === agentId);
    if (!agent) return 100;
    if (tab === "understanding") return understandingScore(agent, selectedRequirements, hasOtherRequirement, listedRequirementsWeight);
    if (tab === "planning") return planningScore(agent, planMarks);
    return outputMarkScore(agent, textMarks).score;
  }

  /** 更新「saveComparison」对应状态，并保持写入顺序、原子性与容量约束。 */
function saveComparison(): void {
    if (saveState === "saved") return;
    const record: DemoSavedComparison = {
      id: "cmp-demo-current",
      title: "本次上下文策略对照",
      createdAt: "08-10 刚刚",
      variantCount: demoAgents.length,
    };
    setComparisonRecords(/** 更新「saveComparison」对应状态，并保持写入顺序、原子性与容量约束。 */
(current) => [record, ...current]);
    setSelectedComparisonId(record.id);
    setSaveState("saved");
  }

  return <div className="comparison-demo-shell">
    <ComparisonHistoryRail records={comparisonRecords} selectedId={selectedComparisonId} />
    <main className="agent-evaluation-demo">
    <header className="demo-header">
      <button aria-label="返回" className="demo-back" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => history.back()} type="button"><ArrowLeft size={17} /></button>
      <div className="demo-title"><span>MODEL CONTEXT · COMPARISON</span><h1>上下文对比实验结果</h1></div>
      <button className={`comparison-save ${saveState}`} disabled={saveState === "saved"} type="button" onClick={saveComparison}>{saveState === "saved" ? <BookmarkCheck size={14} /> : <BookmarkPlus size={14} />}{saveState === "saved" ? "已保存本次结果" : "保存本次对照实验结果"}</button>
    </header>

    <section className="task-panel">
      <p>{demoTask.prompt}</p>
    </section>

    <section className="annotation-mode">
      <AnnotationTabs active={activeTab} completed={completedTabs} onChange={setActiveTab} />
      {activeTab === "answer" && <RawAnswerPanel />}
      {(activeTab === "understanding" || activeTab === "planning" || activeTab === "output") && <div className="annotation-context">
          <span><MousePointer2 size={12} />理解、规划和输出由人工标注</span>
          <span>执行能力自动完成 · 未标注模块默认 100</span>
      </div>}
      {activeTab === "understanding" && <UnderstandingPanel
        hasOtherRequirement={hasOtherRequirement}
        listedRequirementsWeight={listedRequirementsWeight}
        onOtherRequirementToggle={toggleOtherRequirement}
        onWeightChange={/** 处理「onWeightChange」事件，校验归属后再推进状态且避免重复提交。 */
(value) => {
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
    </section>
    </main>
  </div>;
}

/** 原始回答只负责消息流投影；产物跳转策略由当前页面环境决定。 */
function RawAnswerPanel() {
  return <section className="tab-panel raw-answer-panel" role="tabpanel">
    <SectionHeading icon={<MessageSquareText size={17} />} title="原始回答" detail="按上下文、思考、工具与回答的原始顺序展示；产物在新页面中打开。" />
    <AgentComparisonGrid agents={demoAgents} className="answer-grid">
      {/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(agent) => <DemoAgentStream agent={agent} artifacts={demoArtifacts} />}
    </AgentComparisonGrid>
  </section>;
}

/** 渲染「UnderstandingPanel」界面投影，所有业务事实仍由上层状态与服务端提供。 */
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
          {demoTask.requirements.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(requirement) => {
            const selected = selectedRequirements.includes(requirement.id);
            return <button className={selected ? "selected" : ""} key={requirement.id} onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => onToggle(requirement.id)} type="button">
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
                onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(event) => onWeightChange(Number(event.target.value))}
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
        headerScore={/** 执行「headerScore」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(agent) => understandingScore(agent, selectedRequirements, hasOtherRequirement, listedRequirementsWeight)}
      >
        {/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(agent) => <div className="annotation-column-body" title={hasStarted ? `命中 ${understandingMatchCount(agent, selectedRequirements)} / ${demoTask.requirements.length}` : "尚未开始标注，显示默认分"}>
          <div className="agent-understanding-list">
            {agent.understandingPoints.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(point) => {
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

/** 渲染「PlanningPanel」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function PlanningPanel({
  marks,
  onMark,
}: {
  marks: Record<string, MarkColor>;
  onMark: (stepId: string, color: MarkColor) => void;
}) {
  return <section className="tab-panel" role="tabpanel">
    <SectionHeading icon={<Route size={17} />} title="Workflow 规划能力 打分" detail="点击步骤右侧色点添加或取消标记，颜色含义暂不预设。" />
    <AgentComparisonGrid agents={demoAgents} headerScore={/** 执行「headerScore」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(agent) => planningScore(agent, marks)}>
      {/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(agent) => <div className="annotation-column-body">
        <div className="plan-flow">
          {agent.plan.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(step, index) => <div className={`plan-step ${marks[step.id] ? `marked-${marks[step.id]}` : ""}`} key={step.id}>
            <span className="plan-number">{String(index + 1).padStart(2, "0")}</span>
            <div><strong>{step.title}</strong><p>{step.detail}</p></div>
            <div className="plan-marker-actions">
              <button aria-label="蓝色标记" className="blue" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => onMark(step.id, "blue")} type="button" />
              <button aria-label="红色标记" className="red" onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => onMark(step.id, "red")} type="button" />
            </div>
          </div>)}
        </div>
      </div>}
    </AgentComparisonGrid>
  </section>;
}

/** 渲染「OutputPanel」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function OutputPanel({
  marks,
  onMarksChange,
}: {
  marks: TextMark[];
  onMarksChange: (agentId: AgentId, marks: TextMark[]) => void;
}) {
  return <section className="tab-panel" role="tabpanel">
    <SectionHeading icon={<Highlighter size={17} />} title="最终有效输出结果 标注" detail="拖选回答中的任意文本，使用红色或蓝色马克笔；点击已有标注可改色或删除。" />
    <AgentComparisonGrid agents={demoAgents} headerScore={/** 执行「headerScore」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(agent) => outputMarkScore(agent, marks).score}>
      {/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(agent) => {
        const agentMarks = marks.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(mark) => mark.agentId === agent.id);
        return <div className="annotation-column-body">
          <MarkerText
            agentId={agent.id}
            marks={agentMarks}
            onChange={/** 处理「onChange」事件，校验归属后再推进状态且避免重复提交。 */
(next) => onMarksChange(agent.id, next)}
            sections={agent.answerSections}
          />
        </div>;
      }}
    </AgentComparisonGrid>
  </section>;
}

/** 渲染「SummaryPanel」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function SummaryPanel({ scoreFor }: { scoreFor: (tab: ScoreTabId, agentId: AgentId) => number }) {
  return <section className="summary-panel" role="tabpanel">
    <div className="summary-grid">
      <div className="summary-chart-card">
        <SectionHeading icon={<BarChart3 size={17} />} title="综合能力分布" detail="未填写的人工模块按默认满分展示。" />
        <RadarChart agents={demoAgents} scoreFor={/** 执行「scoreFor」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(tab, agent) => scoreFor(tab, agent.id)} />
      </div>
      <div className="score-ledger">
        <div className="ledger-heading"><span>SCORE LEDGER</span><strong>四维评分</strong></div>
        {demoAgents.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(agent) => <div className="ledger-row" key={agent.id}>
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

/** 渲染「ExecutionPanel」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function ExecutionPanel() {
  return <section className="execution-panel" role="tabpanel">
    <SectionHeading icon={<TerminalSquare size={17} />} title="执行能力" detail="Runtime 摘要与执行轨迹集中展示，包括每轮模型调用、工具耗时和错误状态。" />
    <AgentComparisonGrid agents={demoAgents} className="execution-trace-grid" headerScore={(agent) => agent.execution.score} headerScoreLabel="Runtime 自动评分">
      {(agent) => <div className="execution-column">
        <div className="execution-metrics">
          <span><Clock3 size={13} /><strong>{agent.execution.duration}</strong><small>总耗时</small></span>
          <span><CircleDot size={13} /><strong>{agent.execution.modelRounds}</strong><small>Rounds</small></span>
          <span><Wrench size={13} /><strong>{agent.execution.toolCalls}</strong><small>Tools</small></span>
          <span><MessageSquareText size={13} /><strong>{agent.execution.outputTokens}</strong><small>Tokens</small></span>
        </div>
        <ol className="execution-trace">
          {agent.execution.trace.map((item) => <li className={`trace-${item.type} status-${item.status}`} key={item.id}>
            <span className="execution-trace-marker">{item.status === "failed"
              ? <AlertTriangle size={12} />
              : item.type === "tool" ? <Wrench size={12} /> : item.type === "model" ? <BrainCircuit size={12} /> : <CheckCircle2 size={12} />}</span>
            <div>
              <header><small>ROUND {item.round} · {traceTypeLabel(item.type)}</small><strong>{item.title}</strong></header>
              <p>{item.detail}</p>
              <footer><span><Clock3 size={11} />{item.duration}</span><span>{item.status === "failed" ? "发生错误" : "已完成"}</span></footer>
            </div>
          </li>)}
        </ol>
      </div>}
    </AgentComparisonGrid>
  </section>;
}

/** 将轨迹类型转换为稳定的界面文案。 */
function traceTypeLabel(type: "model" | "tool" | "result"): string {
  if (type === "model") return "MODEL";
  if (type === "tool") return "TOOL";
  return "RESULT";
}

/** 渲染「SectionHeading」界面投影，所有业务事实仍由上层状态与服务端提供。 */
function SectionHeading({ icon, title, detail }: { icon: React.ReactNode; title: string; detail: string }) {
  return <div className="demo-section-heading">{icon}<div><h2>{title}</h2><p>{detail}</p></div></div>;
}

/** 执行「understandingScore」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
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

/** 执行「understandingMatchCount」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function understandingMatchCount(agent: DemoAgent, selectedRequirements: string[]): number {
  const understood = new Set(agent.understandingPoints.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(point) => point.requirementId));
  return selectedRequirements.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(requirementId) => understood.has(requirementId)).length;
}

/** 执行「planningScore」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function planningScore(agent: DemoAgent, marks: Record<string, MarkColor>): number {
  const selected = agent.plan.flatMap(/** 执行「selected」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(step) => marks[step.id] ? [marks[step.id]] : []);
  if (selected.length === 0) return 100;
  const weighted = selected.reduce(/** 把当前元素归并到有限累加状态，避免额外复制完整集合。 */
(sum, color) => sum + (color === "red" ? 1 : .5), 0);
  return Math.round(weighted / agent.plan.length * 100);
}

/** 执行「outputMarkScore」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function outputMarkScore(agent: DemoAgent, marks: TextMark[]): {
  score: number;
  redPercent: number;
  bluePercent: number;
  started: boolean;
} {
  const agentMarks = marks.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(mark) => mark.agentId === agent.id);
  if (agentMarks.length === 0) return { score: 100, redPercent: 0, bluePercent: 0, started: false };
  const totalCharacters = agent.answerSections.reduce(/** 把当前元素归并到有限累加状态，避免额外复制完整集合。 */
(sum, section) => sum + effectiveCharacters(section.text), 0);
  let redCharacters = 0;
  let blueCharacters = 0;
  for (const mark of agentMarks) {
    const section = agent.answerSections.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.id === mark.sectionId);
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

/** 执行「effectiveCharacters」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function effectiveCharacters(value: string): number {
  return value.replace(/\s/g, "").length;
}
