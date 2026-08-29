import type { TurnEvaluationRecord } from "@kindergarten/evaluation-contract";
import { EVALUATION_API_URL } from "../deployment-endpoints.js";

/** Exporter 在 Turn 结束后异步上传；短轮询只用于消除点击链接时的上传竞态。 */
export async function loadTurnEvaluation(
  sessionId: string,
  turnId: string,
): Promise<TurnEvaluationRecord | null> {
  const url = `${EVALUATION_API_URL}/turn-evaluations/${encodeURIComponent(sessionId)}/${encodeURIComponent(turnId)}`;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await fetch(url);
    if (response.ok) return await response.json() as TurnEvaluationRecord;
    if (response.status !== 404) {
      const value = await response.json().catch(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => null) as { error?: string } | null;
      throw new Error(value?.error ?? `Evaluation API HTTP ${response.status}`);
    }
    if (attempt < 11) await delay(250);
  }
  return null;
}

/** 执行「delay」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function delay(milliseconds: number): Promise<void> {
  return new Promise(/** 完成当前异步桥接，并保证每条分支只结算一次。 */
(resolve) => setTimeout(resolve, milliseconds));
}
