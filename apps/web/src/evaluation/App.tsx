import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, Gauge } from "lucide-react";
import type { TurnEvaluationRecord } from "@kindergarten/evaluation-contract";
import { loadTurnEvaluation } from "./api.js";
import { AgentEvaluationDemoPage } from "./demo/agent-evaluation/AgentEvaluationDemoPage.js";
import { DemoArtifactPage } from "./demo/agent-evaluation/DemoArtifactPage.js";
import { ExperimentEvaluationPage } from "./experiment/ExperimentEvaluationPage.js";
import { TurnEffectScorePage } from "./turn-effect-score/TurnEffectScorePage.js";
import { ScoreResultRedirect } from "./ScoreResultRedirect.js";
import "./styles.css";

type PageRoute =
  | { kind: "turn"; sessionId: string; turnId: string }
  | { kind: "agent-evaluation-demo" }
  | { kind: "agent-evaluation-demo-artifact"; artifactId: string }
  | { kind: "experiment"; experimentId: string }
  | { kind: "score-result"; scoreResultId: string };

type PageState =
  | { phase: "loading" }
  | { phase: "ready"; record: TurnEvaluationRecord }
  | { phase: "not_found" }
  | { phase: "error"; message: string };

/** 按当前地址装载实验、演示或单 Turn 效果打分页，不在浏览器生成评测事实。 */
export default function App() {
  const route = useMemo(readRoute, []);
  const [state, setState] = useState<PageState>({ phase: "loading" });

  useEffect(/** 单 Turn 页只读取 Runtime 已落盘的客观评测，页面卸载后忽略迟到结果。 */
  () => {
    if (!route) {
      setState({ phase: "error", message: "页面地址缺少 sessionId 或 turnId" });
      return;
    }
    if (route.kind !== "turn") return;
    let disposed = false;
    void loadTurnEvaluation(route.sessionId, route.turnId)
      .then(/** 只在当前页面仍挂载时提交读取结果。 */
      (record) => {
        if (!disposed) setState(record ? { phase: "ready", record } : { phase: "not_found" });
      })
      .catch(/** 将读取失败投影为页面状态，不改变原 Turn 结果。 */
      (error: unknown) => {
        if (!disposed) setState({ phase: "error", message: errorText(error) });
      });
    return /** 页面切换后阻止异步回调覆盖新路由。 */ () => { disposed = true; };
  }, [route]);

  if (route?.kind === "agent-evaluation-demo") return <AgentEvaluationDemoPage />;
  if (route?.kind === "agent-evaluation-demo-artifact") return <DemoArtifactPage artifactId={route.artifactId} />;
  if (route?.kind === "experiment") return <ExperimentEvaluationPage experimentId={route.experimentId} />;
  if (route?.kind === "score-result") return <ScoreResultRedirect scoreResultId={route.scoreResultId} fallback={(message) => <CenteredState title="正在打开评分" detail={message} />} />;
  if (state.phase === "loading") return <CenteredState title="正在读取本轮评测" detail="等待 Runtime Trace 完成上传…" />;
  if (state.phase === "not_found") return <CenteredState title="尚未生成本轮评测" detail="该 Turn 可能仍在后台写入，或 Evaluation 模块当前不可用。" />;
  if (state.phase === "error") return <CenteredState title="无法打开评测" detail={state.message} failed />;
  if (!route || route.kind !== "turn") return <CenteredState title="无法打开评测" detail="页面地址无效" failed />;
  return <TurnEffectScorePage record={state.record} sessionId={route.sessionId} turnId={route.turnId} />;
}

/** 评测尚不可用时保留原页面返回路径，并清楚呈现读取边界。 */
function CenteredState({ title, detail, failed = false }: { title: string; detail: string; failed?: boolean }) {
  return <main className="centered-state"><div className={failed ? "failed" : ""}>{failed ? <AlertTriangle size={20} /> : <Gauge size={20} />}<h1>{title}</h1><p>{detail}</p><button type="button" onClick={/** 返回聊天不发起新的模型或评测请求。 */
  () => history.back()}><ArrowLeft size={14} />返回</button></div></main>;
}

/** 仅接受已声明的评测路径，拒绝缺失或多余的身份段。 */
function readRoute(): PageRoute | null {
  const scoreResult = location.pathname.match(/^\/evaluation\/scores\/([^/]+)\/?$/)?.[1];
  if (scoreResult) return { kind: "score-result", scoreResultId: decodeURIComponent(scoreResult) };
  const demoArtifact = location.pathname.match(/^\/evaluation\/demo\/agent-comparison\/artifacts\/([^/]+)\/?$/)?.[1];
  if (demoArtifact) return { kind: "agent-evaluation-demo-artifact", artifactId: decodeURIComponent(demoArtifact) };
  if (/^\/evaluation\/demo\/agent-comparison\/?$/.test(location.pathname)) return { kind: "agent-evaluation-demo" };
  const experiment = location.pathname.match(/^\/evaluation\/experiments\/([^/]+)\/?$/)?.[1];
  if (experiment) return { kind: "experiment", experimentId: decodeURIComponent(experiment) };
  const match = location.pathname.match(/^\/evaluation\/sessions\/([^/]+)\/turns\/([^/]+)\/?$/);
  return match?.[1] && match[2]
    ? { kind: "turn", sessionId: decodeURIComponent(match[1]), turnId: decodeURIComponent(match[2]) }
    : null;
}

/** 把未知异常转换为可显示文本，避免错误序列化再次抛出。 */
function errorText(value: unknown): string { return value instanceof Error ? value.message : String(value); }
