import { createHash, randomUUID } from "node:crypto";
import {
  parseMcpCandidateInput,
  PRODUCT_CONFIG,
  stableJson,
  type McpCandidateInput,
  type McpCapabilitySnapshot as PublicSnapshot,
  type McpInstallationView,
  type McpTestRecord,
} from "@kindergarten/contracts";
import type { AgentService } from "../agent/agent-service.js";
import { ApiProblemError } from "../server/api-problem.js";
import type { McpManagementRepository } from "./mcp-management-repository.js";
import type { McpClientManager } from "./mcp-client-manager.js";
import type { McpCapabilitySnapshot, McpServerConfig } from "./mcp-types.js";

export class McpManagementService {
  private readonly protectedIds: Set<string>;
  constructor(
    private readonly repository: McpManagementRepository,
    private readonly manager: McpClientManager,
    private readonly agents: AgentService,
  ) { this.protectedIds = new Set(manager.config().servers.map((server) => server.id)); }

  async importExisting(ownerId = "local-admin"): Promise<void> {
    const existing = new Set((await this.repository.listInstallations()).map((item) => item.mcpInstallationId));
    for (const server of this.manager.config().servers) {
      if (existing.has(server.id) || server.transport.kind !== "streamable_http") continue;
      const state = this.manager.serverStates().find((item) => item.serverId === server.id);
      const snapshot = this.manager.capabilitySnapshots().find((item) => item.serverId === server.id);
      const now = new Date().toISOString();
      await this.repository.putInstallation({
        schemaVersion: 1,
        mcpInstallationId: server.id,
        ownerId,
        name: server.displayName,
        transport: "streamable_http",
        url: server.transport.url,
        authKind: server.transport.authProfileId ? "externally_managed_bearer" : "none",
        enabled: server.enabled,
        state: server.enabled ? state?.status === "ready" ? "connected" : "failed" : "disabled",
        deletable: false,
        ...(snapshot ? { snapshot: toPublicSnapshot(snapshot, 1) } : {}),
        ...(state?.connectedAt ? { lastConnectedAt: new Date(state.connectedAt).toISOString() } : {}),
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  async test(raw: unknown, ownerId = "local-admin"): Promise<McpTestRecord> {
    let candidate: McpCandidateInput;
    try { candidate = parseMcpCandidateInput(raw); }
    catch (error) { throw parseProblem(error); }
    const createdAt = new Date();
    const record: McpTestRecord = {
      schemaVersion: 1,
      testId: randomUUID(),
      ownerId,
      candidateHash: hash(candidate),
      candidate,
      state: "testing",
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + PRODUCT_CONFIG.mcp.testResultTtlMs).toISOString(),
    };
    await this.repository.putTest(record);
    try {
      const snapshot = await this.manager.testCandidate(serverConfig(record.testId, candidate));
      const succeeded: McpTestRecord = { ...record, state: "succeeded", snapshot: toPublicSnapshot(snapshot, 1) };
      await this.repository.putTest(succeeded);
      return succeeded;
    } catch (error) {
      const failed: McpTestRecord = {
        ...record,
        state: "failed",
        error: { code: "MCP_CONNECTION_FAILED", message: publicMessage(error), retryable: true },
      };
      await this.repository.putTest(failed);
      return failed;
    }
  }

  async getTest(testId: string, ownerId = "local-admin"): Promise<McpTestRecord> {
    const test = await this.repository.getTest(testId);
    if (!test || test.ownerId !== ownerId) throw new ApiProblemError(404, "NOT_FOUND", "MCP 测试不存在", false);
    if (test.state === "succeeded" && Date.parse(test.expiresAt) <= Date.now()) return { ...test, state: "expired" };
    return test;
  }

  async install(raw: unknown, ownerId = "local-admin"): Promise<McpInstallationView> {
    if (!record(raw) || typeof raw.testId !== "string") throw new ApiProblemError(400, "VALIDATION_FAILED", "testId 必填", false);
    const test = await this.getTest(raw.testId, ownerId);
    if (test.state !== "succeeded" || Date.parse(test.expiresAt) <= Date.now() || !test.snapshot) {
      throw new ApiProblemError(409, "MCP_TEST_EXPIRED", "MCP 测试未成功或已过期", false);
    }
    const requestedName = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : test.candidate.name;
    const id = `mcp_${randomUUID().replaceAll("-", "")}`;
    const now = new Date().toISOString();
    const snapshot = await this.manager.installNoAuth(serverConfig(id, { ...test.candidate, name: requestedName }));
    const view: McpInstallationView = {
      schemaVersion: 1,
      mcpInstallationId: id,
      ownerId,
      name: requestedName,
      transport: "streamable_http",
      url: test.candidate.url,
      authKind: "none",
      enabled: true,
      state: "connected",
      deletable: true,
      snapshot: toPublicSnapshot(snapshot, 1),
      lastAttemptAt: now,
      lastConnectedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await this.repository.putInstallation(view);
    return view;
  }

  async list(ownerId = "local-admin"): Promise<McpInstallationView[]> {
    return (await this.repository.listInstallations())
      .filter((item) => item.ownerId === ownerId && item.state !== "uninstalled")
      .map((item) => ({ ...item, deletable: !this.protectedIds.has(item.mcpInstallationId) }))
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async get(id: string, ownerId = "local-admin"): Promise<McpInstallationView> {
    const value = await this.repository.getInstallation(id);
    if (!value || value.ownerId !== ownerId) throw new ApiProblemError(404, "NOT_FOUND", "MCP Installation 不存在", false);
    return { ...value, deletable: !this.protectedIds.has(value.mcpInstallationId) };
  }

  async reconnect(id: string, ownerId = "local-admin"): Promise<McpInstallationView> {
    const current = await this.get(id, ownerId);
    const snapshot = await this.manager.reconnect(id);
    const now = new Date().toISOString();
    const next = { ...current, state: "connected" as const, enabled: true, snapshot: toPublicSnapshot(snapshot, (current.snapshot?.generation ?? 0) + 1), lastAttemptAt: now, lastConnectedAt: now, updatedAt: now };
    await this.repository.putInstallation(next);
    return next;
  }

  async setEnabled(id: string, enabled: boolean, ownerId = "local-admin"): Promise<McpInstallationView> {
    const current = await this.get(id, ownerId);
    await this.manager.setEnabled(id, enabled);
    const next = { ...current, enabled, state: enabled ? "connected" as const : "disabled" as const, updatedAt: new Date().toISOString() };
    await this.repository.putInstallation(next);
    return next;
  }

  async uninstall(id: string, ownerId = "local-admin"): Promise<{ removedAgentBindings: string[] }> {
    if (this.protectedIds.has(id)) throw new ApiProblemError(409, "CONFLICT", "系统内置 MCP 不可删除", false);
    await this.get(id, ownerId);
    await this.manager.uninstall(id);
    const agents = await this.agents.removeMcpBindings(id, ownerId);
    await this.repository.removeInstallation(id);
    return { removedAgentBindings: agents.map((item) => item.agentId) };
  }
}

function serverConfig(id: string, candidate: McpCandidateInput): McpServerConfig {
  return {
    id,
    displayName: candidate.name,
    enabled: true,
    source: "manual",
    trust: "untrusted",
    transport: { kind: "streamable_http", url: candidate.url, allowPrivateNetwork: isLoopbackUrl(candidate.url) },
  };
}

function toPublicSnapshot(value: McpCapabilitySnapshot, generation: number): PublicSnapshot {
  return {
    schemaVersion: 1,
    generation,
    tools: value.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: structuredClone(tool.inputSchema),
      inputSchemaHash: hash(tool.inputSchema),
    })),
    resources: value.resources.map((item) => ({
      uri: item.uri,
      ...(item.name ? { name: item.name } : {}),
      ...(item.description ? { description: item.description } : {}),
      ...(item.mimeType ? { mimeType: item.mimeType } : {}),
    })),
    prompts: value.prompts.map((item) => ({ name: item.name, ...(item.description ? { description: item.description } : {}) })),
    discoveredAt: new Date(value.fetchedAt).toISOString(),
  };
}

function hash(value: unknown): string { return createHash("sha256").update(stableJson(value)).digest("hex"); }
function isLoopbackUrl(value: string): boolean { return /^(?:http:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/)/i.test(value); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function publicMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function parseProblem(error: unknown): ApiProblemError {
  const message = publicMessage(error);
  if (message.startsWith("MCP_AUTH_NOT_SUPPORTED")) return new ApiProblemError(400, "MCP_AUTH_NOT_SUPPORTED", message, false);
  if (message.startsWith("MCP_URL_NOT_ALLOWED")) return new ApiProblemError(400, "MCP_URL_NOT_ALLOWED", message, false);
  return new ApiProblemError(400, "VALIDATION_FAILED", message, false);
}
