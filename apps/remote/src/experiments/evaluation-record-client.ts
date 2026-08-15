interface TurnEvaluationRecord {
  result: {
    normallyCompleted: boolean;
    firstTokenLatencyMs?: number;
    totalDurationMs: number;
    toolSuccessCount: number;
    toolFailureCount: number;
    errorCount: number;
    permissionViolationCount: number;
    hasRepeatedToolCall: boolean;
    modelRoundCount: number;
    toolCallCount: number;
    totalContextTokens: number;
    totalOutputTokens: number;
  };
}

export interface EvaluationRecordReader {
  get(sessionId: string, turnId: string): Promise<TurnEvaluationRecord | undefined>;
}

export class EvaluationRecordClient implements EvaluationRecordReader {
  constructor(private readonly baseUrl: string, private readonly fetcher: typeof fetch = fetch) {}

  async get(sessionId: string, turnId: string): Promise<TurnEvaluationRecord | undefined> {
    const url = new URL(`/api/v1/turn-evaluations/${encodeURIComponent(sessionId)}/${encodeURIComponent(turnId)}`, ensureSlash(this.baseUrl));
    const response = await this.fetcher(url, { signal: AbortSignal.timeout(3_000) });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Evaluation API HTTP ${response.status}`);
    return await response.json() as TurnEvaluationRecord;
  }
}

function ensureSlash(value: string): string { return value.endsWith("/") ? value : `${value}/`; }
