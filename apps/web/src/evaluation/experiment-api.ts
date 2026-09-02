import type {
  AnyExperimentRecord,
  ExperimentAnnotationWorksheet,
  ExperimentScorecard,
  OutputAnnotationFacts,
  PlanningAnnotationFacts,
  UnderstandingAnnotationFacts,
} from "@kindergarten/contracts";
import { CONTROL_API_URL } from "../deployment-endpoints.js";

const CONTROL_URL = CONTROL_API_URL;

export const experimentApi = {
  get: /** 读取「get」所需数据，并遵守作用域、分页与容量边界。 */
(id: string) => request<AnyExperimentRecord>(`/experiments/${encodeURIComponent(id)}`),
  save: /** 更新「save」对应状态，并保持写入顺序、原子性与容量约束。 */
(id: string) => request<AnyExperimentRecord>(`/experiments/${encodeURIComponent(id)}/save`, "POST", {}),
  failRun: /** 执行「failRun」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(id: string, variantId: string) => request<AnyExperimentRecord>(`/experiments/${encodeURIComponent(id)}/variants/${encodeURIComponent(variantId)}/client-failure`, "POST", {}),
  cancel: /** 判断「cancel」对应条件，只返回判定结果且不修改输入状态。 */
(id: string) => request<{ experiment: AnyExperimentRecord; activeSessionIds: string[] }>(`/experiments/${encodeURIComponent(id)}/cancel`, "POST", {}),
  intervention: /** 执行「intervention」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(id: string, testId: string, fact: { interactionId: string; kind: "permission" | "elicitation"; summary: string; decision: string }) =>
    request<AnyExperimentRecord>(`/experiments/${encodeURIComponent(id)}/tests/${encodeURIComponent(testId)}/interventions`, "POST", fact),
  worksheet: /** 执行「worksheet」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(id: string, force = false) => request<ExperimentAnnotationWorksheet>(`/experiments/${encodeURIComponent(id)}/annotation-worksheet`, "POST", { force }),
  scorecard: /** 执行「scorecard」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(id: string) => request<ExperimentScorecard>(`/experiments/${encodeURIComponent(id)}/scorecard`),
  annotations: /** 执行「annotations」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(id: string, value: { understanding: UnderstandingAnnotationFacts; planning: PlanningAnnotationFacts; output: OutputAnnotationFacts }) =>
    request<ExperimentScorecard>(`/experiments/${encodeURIComponent(id)}/annotations`, "PUT", value),
};

/** 执行「request」主流程，传播取消与失败并在结束时清理临时资源。 */
async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`${CONTROL_URL}${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  const value = await response.json().catch(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => null) as { data?: T; detail?: string; requestId?: string } | null;
  if (!response.ok || !value?.data) {
    const error = new Error(value?.detail ?? `Control API HTTP ${response.status}`) as Error & { requestId?: string };
    if (value?.requestId) error.requestId = value.requestId;
    throw error;
  }
  return value.data;
}
