import { useEffect, useState } from "react";
import { controlApi } from "../api/control-api.js";
import { scoreResultSourceUrl } from "./score-result-link.js";

/** 先按稳定原子 ID 查询来源事实，再跳转实际评分页面。 */
export function ScoreResultRedirect({ scoreResultId, fallback }: { scoreResultId: string; fallback: (message: string) => React.ReactNode }) {
  const [error, setError] = useState<string>();
  useEffect(() => {
    let disposed = false;
    void controlApi.scoreResult(scoreResultId).then((record) => {
      if (!disposed) location.replace(scoreResultSourceUrl(record));
    }).catch((reason: unknown) => {
      if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { disposed = true; };
  }, [scoreResultId]);
  return error ? fallback(error) : fallback("正在定位评分来源…");
}
