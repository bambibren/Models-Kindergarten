import type {
  AgentInput,
  AgentRecord,
  BuiltinSkillOption,
  AnyExperimentRecord,
  ExperimentDraftV2,
  ExperimentRecordV2,
  FileReference,
  FilePreviewResponse,
  McpCandidateInput,
  McpInstallationView,
  McpTestRecord,
  ModelStudentInstallInput,
  ModelStudentCandidateInput,
  ModelStudentDetailView,
  ModelProviderPresetView,
  ModelStudentSummary,
  ModelStudentTestRecord,
  SkillInstallJob,
  SkillInstallation,
  ConcreteReasoningProfile,
  ArtifactListResponse,
  ArtifactPreviewResponse,
  PptxPlaybackResponse,
  ArtifactRecord,
  ArtifactMention,
  ContextSummary,
  ContextWindowUsageState,
  TurnState,
  TurnTokenUsage,
} from "@kindergarten/contracts";
import type { ToolCallContent, ToolCallLocation, ToolCallStatus, ToolKind } from "@agentclientprotocol/sdk";
import { CONTROL_API_URL } from "../deployment-endpoints.js";

const CONTROL_URL = CONTROL_API_URL;

/** 描述「SessionSummary」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
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

/** 描述「SessionLaunchDraft」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface SessionLaunchDraft {
  launchId: string;
  modelStudentId: string;
  agentId: string;
  promptText: string;
  artifactMentions?: import("@kindergarten/contracts").ArtifactMentionInput[];
  reasoningProfileOverride?: ConcreteReasoningProfile;
}

/** 描述「SessionHistoryEntry」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type SessionHistoryEntry =
  | { type: "message"; role: "user" | "assistant"; text: string; turnId: string; messageId: string; createdAt: string; artifactMentions?: ArtifactMention[] }
  | { type: "thought"; text: string; turnId: string; messageId: string; createdAt: string }
  | { type: "context_summary"; turnId: string; summary: ContextSummary; createdAt: string }
  | { type: "token_usage"; turnId: string; usage: TurnTokenUsage; createdAt: string }
  | { type: "context_window_usage"; turnId: string; state: ContextWindowUsageState; createdAt: string }
  | {
      type: "tool_call";
      turnId: string;
      toolCallId: string;
      title: string;
      name: string;
      kind: ToolKind;
      status: ToolCallStatus;
      rawInput: unknown;
      rawOutput?: unknown;
      outcomeStatus?: "success" | "error" | "denied" | "duplicate_blocked";
      content: ToolCallContent[];
      locations: ToolCallLocation[];
      createdAt: string;
    };

/** 描述「SessionTurnPage」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface SessionTurnPage {
  schemaVersion: 1;
  session: SessionSummary;
  turns: Array<{
    turnId: string;
    state: TurnState;
    startedAt: string;
    completedAt?: string;
    entries: SessionHistoryEntry[];
  }>;
  hasMore: boolean;
  nextBeforeTurnId?: string;
}

/** 描述「CapabilityOptions」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface CapabilityOptions {
  builtinTools: string[];
  builtinSkills: BuiltinSkillOption[];
  readySkillInstallationIds: string[];
  mcps: Array<{ installationId: string; tools: string[]; resources: string[] }>;
}

/** 描述「TurnContextSnapshot」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
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
  resolvedReasoning?: import("@kindergarten/contracts").ResolvedReasoningSnapshot;
  agentSnapshotHash: string;
  capabilitySnapshots: unknown[];
  modelRounds: Array<{ roundIndex: number; contextSummary: import("@kindergarten/contracts").ContextSummary; providerInput: import("@kindergarten/contracts").ContextSummaryRaw }>;
}

export const controlApi = {
  agents: /** 执行「agents」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => get<{ items: AgentRecord[] }>("/agents?limit=100"),
  agent: /** 执行「agent」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(id: string) => get<AgentRecord>(`/agents/${encodeURIComponent(id)}`),
  saveAgent: /** 更新「saveAgent」对应状态，并保持写入顺序、原子性与容量约束。 */
(input: AgentInput, id?: string) => request<AgentRecord>(id ? `/agents/${encodeURIComponent(id)}` : "/agents", id ? "PUT" : "POST", input),
  removeAgent: /** 释放或删除「removeAgent」对应资源，重复调用仍保持安全。 */
(id: string) => request<void>(`/agents/${encodeURIComponent(id)}`, "DELETE"),
  capabilityOptions: /** 执行「capabilityOptions」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => get<CapabilityOptions>("/capability-options"),
  models: /** 执行「models」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => get<{ items: ModelStudentSummary[] }>("/model-students"),
  model: /** 读取单个模型完整且不含明文凭据的入园详情。 */
(id: string) => get<ModelStudentDetailView>(`/model-students/${encodeURIComponent(id)}`),
  modelProviderPresets: /** 执行「modelProviderPresets」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => get<{ items: ModelProviderPresetView[] }>("/model-provider-presets"),
  testModelStudent: /** 执行「testModelStudent」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(input: ModelStudentCandidateInput) => request<ModelStudentTestRecord>("/model-student-tests", "POST", input),
  modelStudentTest: /** 执行「modelStudentTest」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(id: string) => get<ModelStudentTestRecord>(`/model-student-tests/${encodeURIComponent(id)}`),
  installModelStudent: /** 执行「installModelStudent」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(input: ModelStudentInstallInput) => request<ModelStudentSummary>("/model-students", "POST", input),
  removeModel: /** 释放或删除「removeModel」对应资源，重复调用仍保持安全。 */
(id: string) => request<void>(`/model-students/${encodeURIComponent(id)}`, "DELETE"),
  sessions: /** 执行「sessions」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => get<{ items: SessionSummary[] }>("/sessions?purpose=chat"),
  sessionTurns: /** 执行「sessionTurns」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(id: string, beforeTurnId?: string) => get<SessionTurnPage>(
    `/sessions/${encodeURIComponent(id)}/turns?limit=20${beforeTurnId ? `&beforeTurnId=${encodeURIComponent(beforeTurnId)}` : ""}`,
  ),
  createSessionLaunch: /** 根据已校验输入构建「createSessionLaunch」结果，不额外持有调用方的大对象。 */
(input: { modelStudentId: string; agentId: string; promptText: string; artifactMentions?: import("@kindergarten/contracts").ArtifactMentionInput[]; reasoningProfileOverride?: ConcreteReasoningProfile }) => request<SessionLaunchDraft>("/session-launches", "POST", input),
  sessionLaunch: /** 执行「sessionLaunch」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(id: string) => get<SessionLaunchDraft>(`/session-launches/${encodeURIComponent(id)}`),
  turn: /** 执行「turn」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(id: string) => get<{ turnId: string; state: import("@kindergarten/contracts").TurnState }>(`/turns/${encodeURIComponent(id)}`),
  turnContext: /** 执行「turnContext」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(id: string) => get<TurnContextSnapshot>(`/turns/${encodeURIComponent(id)}/context`),
  skills: /** 执行「skills」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => get<{ items: SkillInstallation[] }>("/skills"),
  removeSkill: /** 释放或删除「removeSkill」对应资源，重复调用仍保持安全。 */
(id: string) => request<{ removedAgentBindings: string[] }>(`/skills/${encodeURIComponent(id)}`, "DELETE"),
  installSkills: /** 执行「installSkills」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(sourceUrls: string[], agentId?: string) => request<SkillInstallJob>("/skill-install-jobs", "POST", {
    sourceUrls,
    bindToAgentOnComplete: Boolean(agentId),
    ...(agentId ? { agentId } : {}),
  }),
  skillJob: /** 执行「skillJob」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(id: string) => get<SkillInstallJob>(`/skill-install-jobs/${encodeURIComponent(id)}`),
  retrySkillJob: /** 执行「retrySkillJob」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(id: string) => request<SkillInstallJob>(`/skill-install-jobs/${encodeURIComponent(id)}/retry`, "POST", {}),
  mcps: /** 执行「mcps」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => get<McpInstallationView[]>("/mcps"),
  testMcp: /** 执行「testMcp」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(input: McpCandidateInput) => request<McpTestRecord>("/mcp-tests", "POST", input),
  installMcp: /** 执行「installMcp」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(testId: string, name?: string) => request<McpInstallationView>("/mcps", "POST", { testId, ...(name ? { name } : {}) }),
  mcpAction: /** 执行「mcpAction」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(id: string, action: "enable" | "disable" | "reconnect") => request<McpInstallationView>(`/mcps/${encodeURIComponent(id)}/${action}`, "POST", {}),
  removeMcp: /** 释放或删除「removeMcp」对应资源，重复调用仍保持安全。 */
(id: string) => request<{ removedAgentBindings: string[] }>(`/mcps/${encodeURIComponent(id)}`, "DELETE"),
  createExperiment: /** 根据已校验输入构建「createExperiment」结果，不额外持有调用方的大对象。 */
(input: ExperimentDraftV2) => request<ExperimentRecordV2>("/experiments", "POST", input),
  updateExperiment: /** 更新「updateExperiment」对应状态，并保持写入顺序、原子性与容量约束。 */
(id: string, input: ExperimentDraftV2) => request<ExperimentRecordV2>(`/experiments/${encodeURIComponent(id)}`, "PUT", input),
  prepareExperiment: /** 执行「prepareExperiment」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(id: string, idempotencyKey: string) => request<ExperimentRecordV2>(`/experiments/${encodeURIComponent(id)}/prepare-run`, "POST", {}, { "idempotency-key": idempotencyKey }),
  contextPreview: /** 执行「contextPreview」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(input: import("@kindergarten/contracts").ContextPreviewInputV2) => request<import("@kindergarten/contracts").ContextPreviewResponseV2>("/context-previews", "POST", input),
  experiments: /** 执行「experiments」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(saved = false) => get<AnyExperimentRecord[]>(`/experiments${saved ? "?saved=true" : ""}`),
  removeExperiment: /** 释放或删除「removeExperiment」对应资源，重复调用仍保持安全。 */
(id: string) => request<void>(`/experiments/${encodeURIComponent(id)}`, "DELETE"),
  fileReference: /** 执行「fileReference」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(id: string) => get<FileReference>(`/files/${encodeURIComponent(id)}`),
  filePreview: /** 执行「filePreview」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(id: string) => get<FilePreviewResponse>(`/files/${encodeURIComponent(id)}/preview`),
  contentUrl: /** 执行「contentUrl」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(id: string) => `${CONTROL_URL}/files/${encodeURIComponent(id)}/content`,
  artifacts: /** 执行「artifacts」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(query = "", state: "active" | "archived" | "all" = "active") => get<ArtifactListResponse>(`/artifacts?state=${state}&query=${encodeURIComponent(query)}`),
  artifact: /** 执行「artifact」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(id: string) => get<ArtifactRecord>(`/artifacts/${encodeURIComponent(id)}`),
  artifactPreview: /** 执行「artifactPreview」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(id: string) => get<ArtifactPreviewResponse>(`/artifacts/${encodeURIComponent(id)}/preview`),
  artifactPptxPlayback: /** 执行「artifactPptxPlayback」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(id: string) => get<PptxPlaybackResponse>(`/artifacts/${encodeURIComponent(id)}/pptx-playback`),
  artifactContentUrl: /** 执行「artifactContentUrl」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(id: string) => `${CONTROL_URL}/artifacts/${encodeURIComponent(id)}/content`,
  setArtifactState: /** 更新「setArtifactState」对应状态，并保持写入顺序、原子性与容量约束。 */
(id: string, action: "archive" | "restore") => request<ArtifactRecord>(`/artifacts/${encodeURIComponent(id)}/${action}`, "POST", {}),
};

/** 描述「ControlApiError」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export class ControlApiError extends Error {
  /** 初始化「ControlApiError」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly fieldErrors?: Array<{ path: string; message: string }>,
  ) { super(message); }
}

/** 读取「get」所需数据，并遵守作用域、分页与容量边界。 */
async function get<T>(path: string): Promise<T> { return request<T>(path, "GET"); }

/** 执行「request」主流程，传播取消与失败并在结束时清理临时资源。 */
async function request<T>(path: string, method: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
  const response = await fetch(`${CONTROL_URL}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json().catch(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => null) as {
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
