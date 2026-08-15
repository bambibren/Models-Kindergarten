import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRepository } from "../../src/agent/agent-repository.js";
import { AgentService } from "../../src/agent/agent-service.js";
import { McpClientManager } from "../../src/mcp/mcp-client-manager.js";
import { McpConfigStore } from "../../src/mcp/mcp-config-store.js";
import { McpManagementRepository } from "../../src/mcp/mcp-management-repository.js";
import { McpManagementService } from "../../src/mcp/mcp-management-service.js";
import type { McpConnectedClient, McpConnector, McpServerConfig } from "../../src/mcp/mcp-types.js";
import { HostSecretStore } from "../../src/mcp/secret-store.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("McpManagementService", () => {
  it("先测试再安装，公开视图不含 credential", async () => {
    const { service, manager } = await setup();
    const tested = await service.test({
      name: "Demo MCP", transport: "streamable_http", url: "https://example.com/mcp", auth: { kind: "none" },
    });
    expect(tested.state).toBe("succeeded");
    expect(tested.snapshot?.tools[0]).toMatchObject({ name: "echo" });
    const installed = await service.install({ testId: tested.testId });
    expect(installed).toMatchObject({ state: "connected", authKind: "none", enabled: true });
    expect(installed).not.toHaveProperty("auth");
    expect(installed).not.toHaveProperty("credentialRef");
    expect(manager.capabilitySnapshots().some((item) => item.serverId === installed.mcpInstallationId)).toBe(true);
  });

  it("拒绝 Bearer 与未成功测试的安装", async () => {
    const { service } = await setup();
    await expect(service.test({ name: "bad", transport: "streamable_http", url: "https://example.com/mcp", auth: { kind: "bearer", token: "secret" } }))
      .rejects.toMatchObject({ code: "MCP_AUTH_NOT_SUPPORTED" });
    await expect(service.install({ testId: "missing" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("禁用、启用、删除并清理 Agent binding", async () => {
    const { service, agents } = await setup();
    const tested = await service.test({ name: "Demo", transport: "streamable_http", url: "https://example.com/mcp", auth: { kind: "none" } });
    const installed = await service.install({ testId: tested.testId });
    const agent = await agents.create({
      name: "MCP Agent", systemPrompt: "test", builtinTools: [], skillInstallationIds: [],
      mcps: [{
        mcpInstallationId: installed.mcpInstallationId, enabled: true,
        tools: [{ remoteName: "echo", enabled: true, permission: "allow" }], resources: [],
      }],
      historyPolicy: { mode: "none", maxTurns: 0 }, memoryPolicy: { mode: "off" },
    });
    expect((await service.setEnabled(installed.mcpInstallationId, false)).state).toBe("disabled");
    expect((await service.setEnabled(installed.mcpInstallationId, true)).state).toBe("connected");
    expect(await service.uninstall(installed.mcpInstallationId)).toEqual({ removedAgentBindings: [agent.agentId] });
    expect((await agents.get(agent.agentId)).mcps).toEqual([]);
  });

  it("随系统配置加载的内置 MCP 不可删除", async () => {
    const { service } = await setup(true);
    await service.importExisting();
    expect(await service.get("notes")).toMatchObject({ name: "笔记 MCP", deletable: false });
    await expect(service.uninstall("notes")).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
  });
});

async function setup(withBuiltin = false) {
  const dir = await mkdtemp(join(tmpdir(), "mk-mcp-management-"));
  dirs.push(dir);
  const config = new McpConfigStore(join(dir, "mcp.json"));
  if (withBuiltin) await config.save({
    version: 1,
    servers: [{
      id: "notes", displayName: "笔记 MCP", enabled: false, source: "project", trust: "approved",
      transport: { kind: "streamable_http", url: "http://127.0.0.1:9999/mcp", allowPrivateNetwork: true },
    }],
    authProfiles: [],
    agentCapabilities: { mcpTools: [], skills: [], resources: [] },
  });
  const manager = new McpClientManager(
    config, new HostSecretStore(), new FakeConnector(),
  );
  await manager.initialize();
  const agents = new AgentService(new AgentRepository(join(dir, "agents.json")), {
    builtinToolIds: () => [], readySkillInstallationIds: () => [],
    mcpCapabilities: () => manager.capabilitySnapshots().map((item) => ({
      installationId: item.serverId,
      tools: item.tools.map((tool) => tool.name),
      resources: item.resources.map((resource) => resource.uri),
    })),
  });
  const service = new McpManagementService(
    new McpManagementRepository(join(dir, "tests.json"), join(dir, "installations.json")), manager, agents,
  );
  return { service, manager, agents };
}

class FakeConnector implements McpConnector {
  async connect(_server: McpServerConfig): Promise<McpConnectedClient> { return new FakeClient(); }
}

class FakeClient implements McpConnectedClient {
  readonly protocolEra = "modern" as const;
  readonly instructions = undefined;
  async listTools() { return [{ name: "echo", inputSchema: { type: "object" } }]; }
  async listResources() { return [{ uri: "demo://guide", name: "Guide" }]; }
  async listPrompts() { return []; }
  async callTool() { return { isError: false, content: [{ type: "text" as const, text: "ok" }] }; }
  async readResource() { return { contents: [] }; }
  async close() {}
}
