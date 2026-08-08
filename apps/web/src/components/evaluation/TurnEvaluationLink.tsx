import { Activity } from "lucide-react";

const EVALUATION_WEB_URL = import.meta.env.VITE_EVALUATION_WEB_URL ?? "http://127.0.0.1:5175";

/** Chat 只提供导航参数，不读取评测状态，也不渲染 Runtime 数据。 */
export function TurnEvaluationLink({ sessionId, turnId }: {
  sessionId: string;
  turnId: string;
}) {
  const href = new URL(
    `/evaluation/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}`,
    EVALUATION_WEB_URL,
  );
  return <a
    className="turn-evaluation-link"
    href={href.toString()}
    aria-label="查看本轮 Runtime 与评测"
  >
    <Activity size={13} />Runtime 与评测
  </a>;
}
