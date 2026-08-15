import type {
  ExperimentRecord,
  ExperimentAnnotationWorksheet,
  ExperimentScorecard,
  OutputAnnotationFacts,
  PlanningAnnotationFacts,
  UnderstandingAnnotationFacts,
} from "@kindergarten/contracts";

const CONTROL_URL = import.meta.env.VITE_CONTROL_API_URL ?? "http://127.0.0.1:7331/api/control/v1";

export const experimentApi = {
  get: (id: string) => request<ExperimentRecord>(`/experiments/${encodeURIComponent(id)}`),
  save: (id: string) => request<ExperimentRecord>(`/experiments/${encodeURIComponent(id)}/save`, "POST", {}),
  reuse: (id: string, variantId: string) => request<ExperimentRecord>(`/experiments/${encodeURIComponent(id)}/variants/${encodeURIComponent(variantId)}/reuse-snapshot`, "POST", {}),
  failRun: (id: string, variantId: string) => request<ExperimentRecord>(`/experiments/${encodeURIComponent(id)}/variants/${encodeURIComponent(variantId)}/client-failure`, "POST", {}),
  worksheet: (id: string, force = false) => request<ExperimentAnnotationWorksheet>(`/experiments/${encodeURIComponent(id)}/annotation-worksheet`, "POST", { force }),
  scorecard: (id: string) => request<ExperimentScorecard>(`/experiments/${encodeURIComponent(id)}/scorecard`),
  annotations: (id: string, value: { understanding: UnderstandingAnnotationFacts; planning: PlanningAnnotationFacts; output: OutputAnnotationFacts }) =>
    request<ExperimentScorecard>(`/experiments/${encodeURIComponent(id)}/annotations`, "PUT", value),
};

async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`${CONTROL_URL}${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  const value = await response.json().catch(() => null) as { data?: T; detail?: string; requestId?: string } | null;
  if (!response.ok || !value?.data) {
    const error = new Error(value?.detail ?? `Control API HTTP ${response.status}`) as Error & { requestId?: string };
    if (value?.requestId) error.requestId = value.requestId;
    throw error;
  }
  return value.data;
}
