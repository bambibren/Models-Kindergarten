import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PRODUCT_CONFIG } from "@kindergarten/contracts";
import { AgentRepository } from "../../src/agent/agent-repository.js";
import { AgentService } from "../../src/agent/agent-service.js";
import { McpClientManager } from "../../src/mcp/mcp-client-manager.js";
import { McpConfigStore } from "../../src/mcp/mcp-config-store.js";
import { McpManagementRepository } from "../../src/mcp/mcp-management-repository.js";
import { McpManagementService } from "../../src/mcp/mcp-management-service.js";
import type { McpConnectedClient, McpConnector, McpServerConfig } from "../../src/mcp/mcp-types.js";
import { HostSecretStore } from "../../src/mcp/secret-store.js";

const dirs: string[] = [];
afterEach(/** 在每个测试后释放临时资源，保证后续场景从干净状态开始。 */
async () => Promise.all(dirs.splice(0).map(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(dir) => rm(dir, { recursive: true, force: true }))));

describe("McpManagementService", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("先测试再安装，公开视图不含 credential", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const { service, manager } = await setup();
    const tested = await service.test({
      name: "Demo MCP", transport: "streamable_http", url: "https://example.com/mcp", auth: { kind: "none" },
    });
    expect(tested.state).toBe("succeeded");
    expect(Date.parse(tested.expiresAt) - Date.parse(tested.createdAt))
      .toBe(PRODUCT_CONFIG.mcp.testResultTtlMs);
    expect(tested.snapshot?.tools[0]).toMatchObject({ name: "echo" });
    const installed = await service.install({ testId: tested.testId });
    expect(installed).toMatchObject({ state: "connected", authKind: "none", enabled: true });
    expect(installed).not.toHaveProperty("auth");
    expect(installed).not.toHaveProperty("credentialRef");
    expect(manager.capabilitySnapshots().some(/** 构造「toBe」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(item) => item.serverId === installed.mcpInstallationId)).toBe(true);
  });

  it("拒绝 Bearer 与未成功测试的安装", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const { service } = await setup();
    await expect(service.test({ name: "bad", transport: "streamable_http", url: "https://example.com/mcp", auth: { kind: "bearer", token: "secret" } }))
      .rejects.toMatchObject({ code: "MCP_AUTH_NOT_SUPPORTED" });
    await expect(service.install({ testId: "missing" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("禁用、启用、删除并清理 Agent binding", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
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

  it("随系统配置加载的内置 MCP 不可删除", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const { service } = await setup(true);
    await service.importExisting();
    expect(await service.get("notes")).toMatchObject({ name: "笔记 MCP", deletable: false });
    await expect(service.uninstall("notes")).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
  });

  it("MCP 测试过期后首次返回事实并从持久化清理", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const dir = await mkdtemp(join(tmpdir(), "mk-mcp-expired-"));
    dirs.push(dir);
    const testsFile = join(dir, "tests.json");
    await writeFile(testsFile, JSON.stringify({ schemaVersion: 1, records: [{
      schemaVersion: 1,
      testId: "expired",
      ownerId: "local-admin",
      candidateHash: "hash",
      candidate: { name: "旧 MCP", transport: "streamable_http", url: "https://example.com/mcp", auth: { kind: "none" } },
      state: "succeeded",
      createdAt: "2020-01-01T00:00:00.000Z",
      expiresAt: "2020-01-01T00:01:00.000Z",
    }] }), "utf8");
    const repository = new McpManagementRepository(testsFile, join(dir, "installations.json"));

    expect(await repository.getTest("expired")).toMatchObject({ testId: "expired" });
    expect(await repository.getTest("expired")).toBeUndefined();
    expect(JSON.parse(await readFile(testsFile, "utf8"))).toMatchObject({ records: [] });
  });
});

/** 构造「setup」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
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
    builtinToolIds: /** 构造「builtinToolIds」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => [], readySkillInstallationIds: /** 构造「readySkillInstallationIds」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => [],
    mcpCapabilities: /** 构造「mcpCapabilities」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => manager.capabilitySnapshots().map(/** 构造「mcpCapabilities」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(item) => ({
      installationId: item.serverId,
      tools: item.tools.map(/** 构造「tools」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(tool) => tool.name),
      resources: item.resources.map(/** 构造「resources」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(resource) => resource.uri),
    })),
  });
  const service = new McpManagementService(
    new McpManagementRepository(join(dir, "tests.json"), join(dir, "installations.json")), manager, agents,
  );
  return { service, manager, agents };
}

class FakeConnector implements McpConnector {
  /** 构造「connect」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async connect(_server: McpServerConfig): Promise<McpConnectedClient> { return new FakeClient(); }
}

class FakeClient implements McpConnectedClient {
  readonly protocolEra = "modern" as const;
  readonly instructions = undefined;
  /** 构造「listTools」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async listTools() { return [{ name: "echo", inputSchema: { type: "object" } }]; }
  /** 构造「listResources」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async listResources() { return [{ uri: "demo://guide", name: "Guide" }]; }
  /** 构造「listPrompts」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async listPrompts() { return []; }
  /** 构造「callTool」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async callTool() { return { isError: false, content: [{ type: "text" as const, text: "ok" }] }; }
  /** 构造「readResource」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async readResource() { return { contents: [] }; }
  /** 构造「close」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async close() {}
}
