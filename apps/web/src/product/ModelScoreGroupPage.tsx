import { ArrowLeft, Bot, BrainCircuit, ChevronRight, Clock3, Settings2, SlidersHorizontal } from "lucide-react";
import { useCallback } from "react";
import type { ScoreAgentConfigurationSnapshot, ScoreResultRecord } from "@kindergarten/evaluation-contract";
import { controlApi } from "../api/control-api.js";
import { ErrorState, LoadingState } from "./LoadState.js";
import { ProductNav } from "./ProductNav.js";
import { useResource } from "./use-resource.js";

/** 展示一组不可变 Agent 配置及其逐条评分证据，不读取 Agent 当前版本。 */
export function ModelScoreGroupPage({ modelStudentId, configurationHash }: { modelStudentId: string; configurationHash: string }) {
  const load = useCallback(() => controlApi.modelScoreGroup(modelStudentId, configurationHash), [modelStudentId, configurationHash]);
  const { state, retry } = useResource(load);
  return <main className="product-page">
    <ProductNav active="me" />
    <div className="product-editor-shell product-score-detail-shell">
      <header className="product-page-heading">
        <a aria-label="返回模型详情" href={`/models/${encodeURIComponent(modelStudentId)}`}><ArrowLeft size={16} /></a>
        <div><span>MODEL · AGENT CONFIGURATION SCORE</span><h1>Agent 配置组合评分</h1><p>查看参与聚合的冻结配置与每一条原子评分事实。</p></div>
      </header>
      {state.phase === "loading"
        ? <LoadingState label="正在读取配置评分" />
        : state.phase === "error"
          ? <ErrorState {...state} retry={retry} />
          : <div className="product-score-detail-grid">
            <ConfigurationPanel configuration={state.data.configuration} />
            <ScoreHistory history={state.data.history} summary={state.data.summary} />
          </div>}
    </div>
  </main>;
}

function ConfigurationPanel({ configuration }: { configuration: ScoreAgentConfigurationSnapshot }) {
  return <section className="product-score-configuration">
    <header><Settings2 size={16} /><div><strong>当时的 Agent 配置</strong><small>不可变快照 · {configuration.configurationHash.slice(0, 12)}</small></div></header>
    <dl>
      <div><dt><Bot size={14} />Agent</dt><dd>{configuration.agentName}<small>{configuration.agentId} · snapshot {configuration.agentSnapshotHash}</small></dd></div>
      <div><dt><BrainCircuit size={14} />思考档位</dt><dd>{configuration.reasoning.resolvedProfile}<small>{nativeReasoning(configuration)}</small></dd></div>
      <div><dt><Clock3 size={14} />历史策略</dt><dd>{historyLabel(configuration)}</dd></div>
      <div><dt>记忆策略</dt><dd>{configuration.memoryPolicy.mode === "off" ? "关闭" : configuration.memoryPolicy.mode}</dd></div>
    </dl>
    <section><strong>系统提示</strong><pre>{configuration.systemPrompt || "（空）"}</pre></section>
    <BindingList title="内置工具" values={configuration.builtinTools.map((item) => `${item.toolId} · ${item.enabled ? permissionLabel(item.permission) : "停用"}`)} />
    <BindingList title="内置 Skill" values={configuration.builtinSkills.map((item) => `${item.skillId} · ${item.enabled ? "启用" : "停用"}`)} />
    <BindingList title="安装 Skill" values={configuration.skills.map((item) => `${item.skillInstallationId} · ${item.enabled ? "启用" : "停用"}`)} />
    <BindingList title="MCP" values={configuration.mcps.map((item) => {
      const tools = item.tools.map((tool) => `${tool.remoteName}:${tool.enabled ? permissionLabel(tool.permission) : "停用"}`).join(", ") || "无 Tool";
      const resources = item.resources.map((resource) => `${resource.uri}:${resource.enabled ? resource.preload ? "预载" : "启用" : "停用"}`).join(", ") || "无 Resource";
      return `${item.mcpInstallationId} · ${item.enabled ? "启用" : "停用"} · ${tools} · ${resources}`;
    })} />
  </section>;
}

function BindingList({ title, values }: { title: string; values: string[] }) {
  return <section className="product-score-bindings"><strong>{title}</strong>{values.length === 0 ? <span>未启用</span> : <ul>{values.map((value) => <li key={value}>{value}</li>)}</ul>}</section>;
}

function ScoreHistory({ history, summary }: { history: ScoreResultRecord[]; summary: { averageScore: number; minScore: number; maxScore: number; sampleCount: number } }) {
  return <section className="product-score-history">
    <header><div><SlidersHorizontal size={16} /><div><strong>评分历史</strong><small>{summary.sampleCount} 条完整评分</small></div></div><output><strong>{score(summary.averageScore)}</strong><small>[{score(summary.minScore)} ~ {score(summary.maxScore)}]</small></output></header>
    <ol>{history.map((record) => <li key={record.scoreResultId}><a href={`/evaluation/scores/${encodeURIComponent(record.scoreResultId)}`}>
      <span className="product-score-source"><strong>{record.sourceTitle}</strong><small>{sourceLabel(record)} · {formatDateTime(record.updatedAt)}</small></span>
      <span className="product-score-dimensions"><small>理解 {score(record.dimensionScores.understanding ?? 0)}</small><small>规划 {score(record.dimensionScores.planning ?? 0)}</small><small>输出 {score(record.dimensionScores.output ?? 0)}</small><small>执行 {score(record.dimensionScores.execution)}</small></span>
      <span className="product-score-total">{score(record.totalScore ?? 0)}</span><ChevronRight size={15} />
    </a></li>)}</ol>
  </section>;
}

function historyLabel(configuration: ScoreAgentConfigurationSnapshot): string {
  return configuration.historyPolicy.mode === "none" ? "不带历史" : `最近 ${configuration.historyPolicy.maxTurns} 轮`;
}

function nativeReasoning(configuration: ScoreAgentConfigurationSnapshot): string {
  const values = Object.entries(configuration.reasoning.native).map(([key, value]) => `${key}=${String(value)}`);
  return values.length > 0 ? values.join(" · ") : "Provider 无额外参数";
}

function permissionLabel(permission: "allow" | "ask" | "deny"): string {
  if (permission === "allow") return "允许";
  if (permission === "ask") return "询问";
  return "拒绝";
}

function sourceLabel(record: ScoreResultRecord): string {
  return record.source.kind === "context_experiment" ? "上下文实验" : "单轮效果打分";
}

function score(value: number): string { return Number.isInteger(value) ? String(value) : value.toFixed(1); }

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
