import type { ScoreResultRecord } from "@kindergarten/evaluation-contract";

/** 原子评分只根据持久化来源事实决定回链页面，列表不猜测来源类型。 */
export function scoreResultSourceUrl(record: ScoreResultRecord): string {
  if (record.source.kind === "context_experiment") {
    return `/evaluation/experiments/${encodeURIComponent(record.source.experimentId)}?scoreResultId=${encodeURIComponent(record.scoreResultId)}&testId=${encodeURIComponent(record.source.testId)}`;
  }
  return `/evaluation/sessions/${encodeURIComponent(record.source.sessionId)}/turns/${encodeURIComponent(record.source.turnId)}?scoreResultId=${encodeURIComponent(record.scoreResultId)}`;
}
