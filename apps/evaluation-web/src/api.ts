import type { TurnEvaluationRecord } from "@kindergarten/evaluation-contract";

const API_URL = import.meta.env.VITE_EVALUATION_API_URL ?? "http://127.0.0.1:7441";

/** Exporter 在 Turn 结束后异步上传；短轮询只用于消除点击链接时的上传竞态。 */
export async function loadTurnEvaluation(
  sessionId: string,
  turnId: string,
): Promise<TurnEvaluationRecord | null> {
  const url = new URL(
    `/api/v1/turn-evaluations/${encodeURIComponent(sessionId)}/${encodeURIComponent(turnId)}`,
    API_URL,
  );
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await fetch(url);
    if (response.ok) return await response.json() as TurnEvaluationRecord;
    if (response.status !== 404) {
      const value = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(value?.error ?? `Evaluation API HTTP ${response.status}`);
    }
    if (attempt < 11) await delay(250);
  }
  return null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
