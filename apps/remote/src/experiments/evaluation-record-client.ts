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

/** 描述「EvaluationRecordReader」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface EvaluationRecordReader {
  get(sessionId: string, turnId: string): Promise<TurnEvaluationRecord | undefined>;
}

/** 描述「EvaluationRecordClient」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export class EvaluationRecordClient implements EvaluationRecordReader {
  /** 初始化「EvaluationRecordClient」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(private readonly baseUrl: string, private readonly fetcher: typeof fetch = fetch) {}

  /** 读取「get」所需数据，并遵守作用域、分页与容量边界。 */
async get(sessionId: string, turnId: string): Promise<TurnEvaluationRecord | undefined> {
    const url = new URL(`/api/v1/turn-evaluations/${encodeURIComponent(sessionId)}/${encodeURIComponent(turnId)}`, ensureSlash(this.baseUrl));
    const response = await this.fetcher(url, { signal: AbortSignal.timeout(3_000) });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Evaluation API HTTP ${response.status}`);
    return await response.json() as TurnEvaluationRecord;
  }
}

/** 校验并取得「ensureSlash」所需对象；缺失或归属不符时立即抛出明确错误。 */
function ensureSlash(value: string): string { return value.endsWith("/") ? value : `${value}/`; }
