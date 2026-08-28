import type { ModelReasoningCapability } from "@kindergarten/contracts";

/** 描述「DemoArtifactKind」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type DemoArtifactKind = "markdown" | "html";

/** 描述「DemoArtifact」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface DemoArtifact {
  id: string;
  name: string;
  kind: DemoArtifactKind;
  content: string;
}

/** 描述「DemoSession」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface DemoSession {
  id: string;
  title: string;
  updatedAt: string;
  preview: string;
}

/** 描述「DemoContextItem」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface DemoContextItem {
  id: string;
  title: string;
  detail: string;
  tokens: number;
  raw: string;
}

/** 描述「DemoMcpAuthKind」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type DemoMcpAuthKind = "none" | "bearer";
/** 描述「DemoMcpConnectionState」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type DemoMcpConnectionState = "ready" | "reconnecting" | "auth_required" | "failed" | "disabled";
/** 描述「DemoMcpCapabilityKind」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type DemoMcpCapabilityKind = "tool" | "resource" | "prompt";

/** 描述「DemoMcpCapability」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface DemoMcpCapability {
  name: string;
  kind: DemoMcpCapabilityKind;
  description: string;
  readOnly?: boolean;
}

/** 描述「DemoMcpInstallation」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface DemoMcpInstallation {
  id: string;
  name: string;
  description: string;
  url: string;
  transport: "streamable_http";
  authKind: DemoMcpAuthKind;
  credentialHint?: string;
  state: DemoMcpConnectionState;
  capabilities: DemoMcpCapability[];
  boundAgentIds: string[];
  lastCheckedAt: string;
}

/** 描述「DemoStreamItem」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type DemoStreamItem =
  | {
      id: string;
      type: "user";
      text: string;
      inputTokens: number;
    }
  | {
      id: string;
      type: "context";
      turnId: string;
      totalTokens: number;
      items: DemoContextItem[];
      experimentEntry?: boolean;
    }
  | {
      id: string;
      type: "thought";
      title: string;
      text: string;
      tokens: number;
    }
  | {
      id: string;
      type: "mcp_boundary";
      agentName: string;
      allowedMcps: Array<{ id: string; name: string; toolCount: number }>;
      excludedCount: number;
    }
  | {
      id: string;
      type: "tool";
      name: string;
      status: "in_progress" | "completed" | "failed";
      input: string;
      output: string;
      tokens: number;
      source?: "builtin" | "mcp";
      serverName?: string;
      toolCallId?: string;
      requiredMcpId?: string;
    }
  | {
      id: string;
      type: "assistant";
      markdown: string;
      outputTokens: number;
      artifactIds?: string[];
      projectionKey?: "mcp-demo-summary";
    };

/** 描述「ContextExperimentMode」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ContextExperimentMode = "fresh_prompt" | "history_turn";
/** 描述「VersionRunPolicy」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type VersionRunPolicy = "run" | "reuse_snapshot";
/** 描述「ContextModuleId」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ContextModuleId = "system" | "tools" | "mcp" | "skills" | "memory" | "history";

/** 描述「DemoContextModule」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface DemoContextModule {
  id: ContextModuleId;
  title: string;
  detail: string;
  enabled: boolean;
  tokens: number | null;
  value: string;
  selectedItems?: string[];
  historyTurns?: number;
}

/** 描述「DemoContextVersion」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface DemoContextVersion {
  id: "a" | "b" | "c";
  name: string;
  locked: boolean;
  runPolicy: VersionRunPolicy;
  modules: DemoContextModule[];
}

/** 描述「DemoModelStudent」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface DemoModelStudent {
  id: string;
  name: string;
  model: string;
  provider: string;
  protocol: DemoProviderProtocol;
  baseUrl: string;
  credentialHint?: string;
  capabilities: DemoModelCapabilities;
  score: number | null;
  state: "在读" | "旁听" | "待评测" | "不可用";
}

/** 描述「DemoProviderProtocol」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type DemoProviderProtocol = "ollama_native" | "openai_chat_completions" | "openai_responses";
/** 描述「DemoCapabilityState」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type DemoCapabilityState = "supported" | "unsupported" | "unverified";

/** 描述「DemoModelCapabilities」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface DemoModelCapabilities {
  streaming: DemoCapabilityState;
  toolCalls: DemoCapabilityState;
  reasoning: DemoCapabilityState;
  usage: DemoCapabilityState;
  reasoningControl: ModelReasoningCapability;
}

/** 描述「DemoAgentStrategy」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface DemoAgentStrategy {
  id: string;
  name: string;
  description: string;
  modules: DemoContextModule[];
  updatedAt: string;
  state: "active" | "draft";
}

/** 描述「DemoExperimentRecord」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface DemoExperimentRecord {
  id: string;
  title: string;
  prompt: string;
  model: string;
  versionCount: number;
  createdAt: string;
  status: "saved";
}

/** 描述「DemoResourceRow」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface DemoResourceRow {
  id: string;
  name: string;
  detail: string;
  meta: string;
  state: string;
}
