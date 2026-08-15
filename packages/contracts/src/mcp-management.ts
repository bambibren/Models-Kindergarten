import { isRecord, requiredString } from "./common.js";

export type McpCandidateInput = {
  name: string;
  transport: "streamable_http";
  url: string;
  auth: { kind: "none" };
};

export interface McpCapabilitySnapshot {
  schemaVersion: 1;
  generation: number;
  tools: Array<{ name: string; description?: string; inputSchema: unknown; inputSchemaHash: string }>;
  resources: Array<{ uri: string; name?: string; description?: string; mimeType?: string }>;
  prompts: Array<{ name: string; description?: string }>;
  discoveredAt: string;
}

export interface McpTestRecord {
  schemaVersion: 1;
  testId: string;
  ownerId: string;
  candidateHash: string;
  candidate: McpCandidateInput;
  state: "queued" | "testing" | "succeeded" | "failed" | "expired";
  snapshot?: McpCapabilitySnapshot;
  error?: import("./common.js").PublicErrorRef;
  createdAt: string;
  expiresAt: string;
}

export type McpConnectionState = "installing" | "connecting" | "connected" | "degraded" | "disconnected" | "disabled" | "failed" | "uninstalled";

export interface McpInstallationView {
  schemaVersion: 1;
  mcpInstallationId: string;
  ownerId: string;
  name: string;
  transport: "streamable_http";
  url: string;
  authKind: "none" | "externally_managed_bearer";
  enabled: boolean;
  state: McpConnectionState;
  snapshot?: McpCapabilitySnapshot;
  lastConnectedAt?: string;
  lastAttemptAt?: string;
  nextRetryAt?: string;
  createdAt: string;
  updatedAt: string;
  deletable?: boolean;
}

export function parseMcpCandidateInput(value: unknown): McpCandidateInput {
  if (!isRecord(value)) throw new Error("MCP candidate 必须是对象");
  if (!isRecord(value.auth) || value.auth.kind !== "none" || Object.keys(value.auth).some((key) => key !== "kind")) {
    throw new Error("MCP_AUTH_NOT_SUPPORTED: 本轮只接受 auth none");
  }
  if (value.transport !== "streamable_http") throw new Error("MCP transport 首版只能为 streamable_http");
  const url = requiredString(value, "url", { max: 2_048 });
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("MCP_URL_NOT_ALLOWED: URL 无效");
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback(parsed.hostname))) {
    throw new Error("MCP_URL_NOT_ALLOWED: 只允许 HTTPS；开发时允许 loopback HTTP");
  }
  if (parsed.username || parsed.password || parsed.hash) throw new Error("MCP_URL_NOT_ALLOWED: URL 不能包含凭据或 fragment");
  return {
    name: requiredString(value, "name", { max: 80 }),
    transport: "streamable_http",
    url: parsed.toString(),
    auth: { kind: "none" },
  };
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}
