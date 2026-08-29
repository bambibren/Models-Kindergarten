import type { AuthProvider, ContentBlock } from "@modelcontextprotocol/client";
import type { AgentCapabilitySet } from "../capability/capability-types.js";
import type { PermissionMode } from "../tools/tool-registry.js";

/** 描述「SecretRef」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type SecretRef =
  | { provider: "env"; key: string }
  | { provider: "managed"; key: string }
  /** 旧持久化格式；读取和迁移兼容，新写入不得再使用。 */
  | { provider: "keychain"; key: string };

/** 描述「McpStdioSandboxPolicy」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface McpStdioSandboxPolicy {
  readPaths?: string[];
  writePaths?: string[];
  network?: boolean;
}

/** 描述「McpTransportConfig」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
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

/** 描述「McpServerConfig」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface McpServerConfig {
  id: string;
  displayName: string;
  enabled: boolean;
  source: "manual" | "project" | "registry";
  trust: "approved" | "untrusted";
  transport: McpTransportConfig;
}

/** 描述「McpAuthProfile」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface McpAuthProfile {
  id: string;
  kind: "none" | "bearer" | "oauth";
  tokenRef?: SecretRef;
}

/** 描述「McpConfigDocument」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface McpConfigDocument {
  version: 1;
  servers: McpServerConfig[];
  authProfiles: McpAuthProfile[];
  agentCapabilities: AgentCapabilitySet;
}

/** 描述「McpFailureCategory」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type McpFailureCategory =
  | "configuration"
  | "authentication"
  | "transport"
  | "protocol"
  | "discovery"
  | "validation"
  | "remote_tool"
  | "cancelled";

/** 描述「McpFailure」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface McpFailure {
  category: McpFailureCategory;
  message: string;
  retryable: boolean;
}

/** 描述「McpServerState」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface McpServerState {
  serverId: string;
  status: "disconnected" | "connecting" | "ready" | "capacity_blocked" | "auth_required" | "failed";
  protocolEra?: "modern" | "legacy";
  connectedAt?: number;
  lastError?: McpFailure;
}

/** 描述「McpToolDescriptor」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
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

/** 描述「McpResourceDescriptor」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface McpResourceDescriptor {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

/** 描述「McpPromptDescriptor」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface McpPromptDescriptor {
  name: string;
  title?: string;
  description?: string;
}

/** 描述「McpCapabilitySnapshot」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
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

/** 描述「McpToolCallResult」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface McpToolCallResult {
  isError: boolean;
  structuredContent?: unknown;
  content: ContentBlock[];
}

/** 描述「McpResourceReadResult」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface McpResourceReadResult {
  contents: unknown[];
}

/** 描述「McpInteractionPort」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface McpInteractionPort {
  askUser(message: string, toolCallId: string): Promise<string>;
}

/** 描述「McpConnectedClient」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
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

/** 描述「McpConnector」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface McpConnector {
  connect(
    server: McpServerConfig,
    auth: AuthProvider | undefined,
    headers: Record<string, string>,
  ): Promise<McpConnectedClient>;
}

/** 描述「McpToolBinding」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface McpToolBinding {
  capabilityId: string;
  modelName: string;
  serverId: string;
  remoteName: string;
  permission: PermissionMode;
  descriptor: McpToolDescriptor;
}

/** 由规范字段生成稳定的「mcpToolCapabilityId」标识，供索引精确定位且不保留原始大对象。 */
export function mcpToolCapabilityId(serverId: string, toolName: string): string {
  return `mcp:${serverId}:tool:${toolName}`;
}
