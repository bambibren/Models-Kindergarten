import type { ModelReasoningCapability } from "@kindergarten/contracts";

export type DemoArtifactKind = "markdown" | "html";

export interface DemoArtifact {
  id: string;
  name: string;
  kind: DemoArtifactKind;
  content: string;
}

export interface DemoSession {
  id: string;
  title: string;
  updatedAt: string;
  preview: string;
}

export interface DemoContextItem {
  id: string;
  title: string;
  detail: string;
  tokens: number;
  raw: string;
}

export type DemoMcpAuthKind = "none" | "bearer";
export type DemoMcpConnectionState = "ready" | "reconnecting" | "auth_required" | "failed" | "disabled";
export type DemoMcpCapabilityKind = "tool" | "resource" | "prompt";

export interface DemoMcpCapability {
  name: string;
  kind: DemoMcpCapabilityKind;
  description: string;
  readOnly?: boolean;
}

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

export type ContextExperimentMode = "fresh_prompt" | "history_turn";
export type VersionRunPolicy = "run" | "reuse_snapshot";
export type ContextModuleId = "system" | "tools" | "mcp" | "skills" | "memory" | "history";

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

export interface DemoContextVersion {
  id: "a" | "b" | "c";
  name: string;
  locked: boolean;
  runPolicy: VersionRunPolicy;
  modules: DemoContextModule[];
}

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

export type DemoProviderProtocol = "ollama_native" | "openai_chat_completions" | "openai_responses";
export type DemoCapabilityState = "supported" | "unsupported" | "unverified";

export interface DemoModelCapabilities {
  streaming: DemoCapabilityState;
  toolCalls: DemoCapabilityState;
  reasoning: DemoCapabilityState;
  usage: DemoCapabilityState;
  reasoningControl: ModelReasoningCapability;
}

export interface DemoAgentStrategy {
  id: string;
  name: string;
  description: string;
  modules: DemoContextModule[];
  updatedAt: string;
  state: "active" | "draft";
}

export interface DemoExperimentRecord {
  id: string;
  title: string;
  prompt: string;
  model: string;
  versionCount: number;
  createdAt: string;
  status: "saved";
}

export interface DemoResourceRow {
  id: string;
  name: string;
  detail: string;
  meta: string;
  state: string;
}
