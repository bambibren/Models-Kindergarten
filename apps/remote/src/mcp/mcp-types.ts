import type { AuthProvider, ContentBlock } from "@modelcontextprotocol/client";
import type { AgentCapabilitySet } from "../capability/capability-types.js";
import type { PermissionMode } from "../tools/tool-registry.js";

export type SecretRef =
  | { provider: "env"; key: string }
  | { provider: "keychain"; key: string };

export interface McpStdioSandboxPolicy {
  readPaths?: string[];
  writePaths?: string[];
  network?: boolean;
}

export type McpTransportConfig =
  | {
      kind: "stdio";
      command: string;
      args?: string[];
      cwd?: string;
      envRefs?: Record<string, SecretRef>;
      sandbox?: McpStdioSandboxPolicy;
    }
  | {
      kind: "streamable_http";
      url: string;
      authProfileId?: string;
      headerRefs?: Record<string, SecretRef>;
      allowPrivateNetwork?: boolean;
    };

export interface McpServerConfig {
  id: string;
  displayName: string;
  enabled: boolean;
  source: "manual" | "project" | "registry";
  trust: "approved" | "untrusted";
  transport: McpTransportConfig;
}

export interface McpAuthProfile {
  id: string;
  kind: "none" | "bearer" | "oauth";
  tokenRef?: SecretRef;
}

export interface McpConfigDocument {
  version: 1;
  servers: McpServerConfig[];
  authProfiles: McpAuthProfile[];
  agentCapabilities: AgentCapabilitySet;
}

export type McpFailureCategory =
  | "configuration"
  | "authentication"
  | "transport"
  | "protocol"
  | "discovery"
  | "validation"
  | "remote_tool"
  | "cancelled";

export interface McpFailure {
  category: McpFailureCategory;
  message: string;
  retryable: boolean;
}

export interface McpServerState {
  serverId: string;
  status: "disconnected" | "connecting" | "ready" | "auth_required" | "failed";
  protocolEra?: "modern" | "legacy";
  connectedAt?: number;
  lastError?: McpFailure;
}

export interface McpToolDescriptor {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface McpResourceDescriptor {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptDescriptor {
  name: string;
  title?: string;
  description?: string;
}

export interface McpCapabilitySnapshot {
  serverId: string;
  revision: string;
  fetchedAt: number;
  expiresAt?: number;
  instructions?: string;
  tools: McpToolDescriptor[];
  resources: McpResourceDescriptor[];
  prompts: McpPromptDescriptor[];
}

export interface McpToolCallResult {
  isError: boolean;
  structuredContent?: unknown;
  content: ContentBlock[];
}

export interface McpResourceReadResult {
  contents: unknown[];
}

export interface McpInteractionPort {
  askUser(message: string, toolCallId: string): Promise<string>;
}

export interface McpConnectedClient {
  readonly protocolEra: "modern" | "legacy";
  readonly instructions: string | undefined;
  listTools(): Promise<McpToolDescriptor[]>;
  listResources(): Promise<McpResourceDescriptor[]>;
  listPrompts(): Promise<McpPromptDescriptor[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    toolCallId: string,
    interaction: McpInteractionPort,
    signal: AbortSignal,
  ): Promise<McpToolCallResult>;
  readResource(uri: string, signal: AbortSignal): Promise<McpResourceReadResult>;
  close(): Promise<void>;
}

export interface McpConnector {
  connect(
    server: McpServerConfig,
    auth: AuthProvider | undefined,
    headers: Record<string, string>,
  ): Promise<McpConnectedClient>;
}

export interface McpToolBinding {
  capabilityId: string;
  modelName: string;
  serverId: string;
  remoteName: string;
  permission: PermissionMode;
  descriptor: McpToolDescriptor;
}

export function mcpToolCapabilityId(serverId: string, toolName: string): string {
  return `mcp:${serverId}:tool:${toolName}`;
}
