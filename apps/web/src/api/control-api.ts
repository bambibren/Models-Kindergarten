import type {
  AgentInput,
  AgentRecord,
  ExperimentDraftInput,
  ExperimentRecord,
  FileReference,
  FilePreviewResponse,
  McpCandidateInput,
  McpInstallationView,
  McpTestRecord,
  ModelStudentInstallInput,
  ModelStudentCandidateInput,
  ModelProviderPresetView,
  ModelStudentSummary,
  ModelStudentTestRecord,
  SkillInstallJob,
  SkillInstallation,
  ConcreteReasoningProfile,
} from "@kindergarten/contracts";

const CONTROL_URL = import.meta.env.VITE_CONTROL_API_URL ?? "http://127.0.0.1:7331/api/control/v1";

export interface SessionSummary {
  sessionId: string;
  purpose: "chat" | "experiment";
  cwd: string;
  title: string;
  modelStudentId: string;
  agentId: string;
  preview: string;
  turnCount: number;
  updatedAt: string;
  createdAt: string;
}

export interface SessionLaunchDraft {
  launchId: string;
  modelStudentId: string;
  agentId: string;
  promptText: string;
  reasoningProfileOverride?: ConcreteReasoningProfile;
}

export interface CapabilityOptions {
  builtinTools: string[];
  readySkillInstallationIds: string[];
  mcps: Array<{ installationId: string; tools: string[]; resources: string[] }>;
}

export interface TurnContextSnapshot {
  schemaVersion: 1;
  turn: {
    turnId: string;
    sessionId: string;
    state: import("@kindergarten/contracts").TurnState;
    modelStudentId: string;
    agentId: string;
  };
  promptText: string;
  answerTexts: string[];
  sourcePolicy: import("@kindergarten/contracts").ExperimentContextPolicy;
  agentSnapshotHash: string;
  capabilitySnapshots: unknown[];
  modelRounds: Array<{ roundIndex: number; contextSummary: import("@kindergarten/contracts").ContextSummary; providerInput: import("@kindergarten/contracts").ContextSummaryRaw }>;
}

export const controlApi = {
  agents: () => get<{ items: AgentRecord[] }>("/agents?limit=100"),
  agent: (id: string) => get<AgentRecord>(`/agents/${encodeURIComponent(id)}`),
  saveAgent: (input: AgentInput, id?: string) => request<AgentRecord>(id ? `/agents/${encodeURIComponent(id)}` : "/agents", id ? "PUT" : "POST", input),
  removeAgent: (id: string) => request<void>(`/agents/${encodeURIComponent(id)}`, "DELETE"),
  capabilityOptions: () => get<CapabilityOptions>("/capability-options"),
  models: () => get<{ items: ModelStudentSummary[] }>("/model-students"),
  modelProviderPresets: () => get<{ items: ModelProviderPresetView[] }>("/model-provider-presets"),
  testModelStudent: (input: ModelStudentCandidateInput) => request<ModelStudentTestRecord>("/model-student-tests", "POST", input),
  modelStudentTest: (id: string) => get<ModelStudentTestRecord>(`/model-student-tests/${encodeURIComponent(id)}`),
  installModelStudent: (input: ModelStudentInstallInput) => request<ModelStudentSummary>("/model-students", "POST", input),
  removeModel: (id: string) => request<void>(`/model-students/${encodeURIComponent(id)}`, "DELETE"),
  sessions: () => get<{ items: SessionSummary[] }>("/sessions?purpose=chat"),
  createSessionLaunch: (input: { modelStudentId: string; agentId: string; promptText: string; reasoningProfileOverride?: ConcreteReasoningProfile }) => request<SessionLaunchDraft>("/session-launches", "POST", input),
  sessionLaunch: (id: string) => get<SessionLaunchDraft>(`/session-launches/${encodeURIComponent(id)}`),
  turn: (id: string) => get<{ turnId: string; state: import("@kindergarten/contracts").TurnState }>(`/turns/${encodeURIComponent(id)}`),
  turnContext: (id: string) => get<TurnContextSnapshot>(`/turns/${encodeURIComponent(id)}/context`),
  skills: () => get<{ items: SkillInstallation[] }>("/skills"),
  removeSkill: (id: string) => request<{ removedAgentBindings: string[] }>(`/skills/${encodeURIComponent(id)}`, "DELETE"),
  installSkills: (sourceUrls: string[], agentId?: string) => request<SkillInstallJob>("/skill-install-jobs", "POST", {
    sourceUrls,
    bindToAgentOnComplete: Boolean(agentId),
    ...(agentId ? { agentId } : {}),
  }),
  skillJob: (id: string) => get<SkillInstallJob>(`/skill-install-jobs/${encodeURIComponent(id)}`),
  retrySkillJob: (id: string) => request<SkillInstallJob>(`/skill-install-jobs/${encodeURIComponent(id)}/retry`, "POST", {}),
  mcps: () => get<McpInstallationView[]>("/mcps"),
  testMcp: (input: McpCandidateInput) => request<McpTestRecord>("/mcp-tests", "POST", input),
  installMcp: (testId: string, name?: string) => request<McpInstallationView>("/mcps", "POST", { testId, ...(name ? { name } : {}) }),
  mcpAction: (id: string, action: "enable" | "disable" | "reconnect") => request<McpInstallationView>(`/mcps/${encodeURIComponent(id)}/${action}`, "POST", {}),
  removeMcp: (id: string) => request<{ removedAgentBindings: string[] }>(`/mcps/${encodeURIComponent(id)}`, "DELETE"),
  createExperiment: (input: ExperimentDraftInput) => request<ExperimentRecord>("/experiments", "POST", input),
  contextPreview: (input: import("@kindergarten/contracts").ContextPreviewInput) => request<import("@kindergarten/contracts").ContextPreviewResponse>("/context-previews", "POST", input),
  experiments: (saved = false) => get<ExperimentRecord[]>(`/experiments${saved ? "?saved=true" : ""}`),
  removeExperiment: (id: string) => request<void>(`/experiments/${encodeURIComponent(id)}`, "DELETE"),
  fileReference: (id: string) => get<FileReference>(`/files/${encodeURIComponent(id)}`),
  filePreview: (id: string) => get<FilePreviewResponse>(`/files/${encodeURIComponent(id)}/preview`),
  contentUrl: (id: string) => `${CONTROL_URL}/files/${encodeURIComponent(id)}/content`,
};

export class ControlApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly fieldErrors?: Array<{ path: string; message: string }>,
  ) { super(message); }
}

async function get<T>(path: string): Promise<T> { return request<T>(path, "GET"); }

async function request<T>(path: string, method: string, body?: unknown): Promise<T> {
  const response = await fetch(`${CONTROL_URL}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const value = await response.json().catch(() => null) as {
    data?: T;
    detail?: string;
    code?: string;
    requestId?: string;
    fieldErrors?: Array<{ path: string; message: string }>;
  } | null;
  if (!response.ok) {
    throw new ControlApiError(
      value?.code ?? "HTTP_ERROR",
      value?.detail ?? `Control API HTTP ${response.status}`,
      value?.requestId,
      value?.fieldErrors,
    );
  }
  return value?.data as T;
}
