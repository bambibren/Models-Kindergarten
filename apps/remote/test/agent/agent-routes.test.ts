import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRepository } from "../../src/agent/agent-repository.js";
import { registerAgentRoutes } from "../../src/agent/agent-routes.js";
import { AgentService } from "../../src/agent/agent-service.js";
import { ControlApi } from "../../src/server/control-api.js";

const dirs: string[] = [];
afterEach(/** 在每个测试后释放临时资源，保证后续场景从干净状态开始。 */
async () => Promise.all(dirs.splice(0).map(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(dir) => rm(dir, { recursive: true, force: true }))));

describe("Agent routes", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("提供 Agent create/get/list/update/delete，但没有归档或迁移", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const dir = await mkdtemp(join(tmpdir(), "mk-agent-routes-"));
    dirs.push(dir);
    const api = new ControlApi({ allowedOrigins: ["http://127.0.0.1:5174"] });
    const service = new AgentService(new AgentRepository(join(dir, "agents.json")), {
      builtinToolIds: /** 构造「builtinToolIds」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => ["read_file"], readySkillInstallationIds: /** 构造「readySkillInstallationIds」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => Promise.resolve([]), mcpCapabilities: /** 构造「mcpCapabilities」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => Promise.resolve([]),
    });
    registerAgentRoutes(api.router, service);
    const body = {
      name: "本地助手", systemPrompt: "如实回答", builtinTools: [], skillInstallationIds: [], mcps: [],
      historyPolicy: { mode: "none" }, memoryPolicy: { mode: "off" },
    };
    const created = await json(api, "/agents", "POST", body);
    expect(created.response.status).toBe(201);
    const agentId = (created.value.data as { agentId: string }).agentId;

    const detail = await json(api, `/agents/${agentId}`, "GET");
    expect(detail.value.data).toMatchObject({ agentId, name: "本地助手" });
    const updated = await json(api, `/agents/${agentId}`, "PUT", { ...body, name: "新名称" });
    expect(updated.value.data).toMatchObject({ agentId, name: "新名称" });
    const listed = await json(api, "/agents?query=新名称", "GET");
    expect((listed.value.data as { items: unknown[] }).items).toHaveLength(1);

    expect((await json(api, `/agents/${agentId}`, "DELETE")).response.status).toBe(200);
    expect((await json(api, `/agents/${agentId}`, "GET")).response.status).toBe(404);
    expect((await json(api, `/agents/${agentId}/archive`, "POST", {})).response.status).toBe(404);
  });

  it("系统默认 Agent 不暴露删除能力且接口拒绝删除", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const dir = await mkdtemp(join(tmpdir(), "mk-agent-protected-"));
    dirs.push(dir);
    const api = new ControlApi({ allowedOrigins: ["http://127.0.0.1:5174"] });
    const service = new AgentService(new AgentRepository(join(dir, "agents.json")), {
      builtinToolIds: /** 构造「builtinToolIds」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => [], readySkillInstallationIds: /** 构造「readySkillInstallationIds」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => Promise.resolve([]), mcpCapabilities: /** 构造「mcpCapabilities」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => Promise.resolve([]),
    });
    registerAgentRoutes(api.router, service);
    const created = await service.create({
      name: "系统默认 Agent", systemPrompt: "test", builtinTools: [], skillInstallationIds: [], mcps: [],
      historyPolicy: { mode: "none" }, memoryPolicy: { mode: "off" },
    });
    service.protect(created.agentId);

    expect((await service.get(created.agentId)).deletable).toBe(false);
    const removed = await json(api, `/agents/${created.agentId}`, "DELETE");
    expect(removed.response.status).toBe(409);
    expect(await service.get(created.agentId)).toMatchObject({ agentId: created.agentId, deletable: false });
  });

  it("账号首次读取列表时自动得到默认 Agent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mk-agent-default-route-"));
    dirs.push(dir);
    const api = new ControlApi({ allowedOrigins: ["http://127.0.0.1:5174"] });
    const service = new AgentService(new AgentRepository(join(dir, "agents.json")), {
      builtinToolIds: () => [], readySkillInstallationIds: () => Promise.resolve([]), mcpCapabilities: () => Promise.resolve([]),
    });
    const defaultAgentInput = () => ({
      name: "系统默认 Agent",
      systemPrompt: "默认系统提示词",
      builtinTools: [],
      skillInstallationIds: [],
      mcps: [],
      historyPolicy: { mode: "recent_turns" as const, maxTurns: 12 },
      memoryPolicy: { mode: "off" as const },
    });
    registerAgentRoutes(api.router, service, { defaultAgentInput });

    const first = await json(api, "/agents", "GET");
    const repeated = await json(api, "/agents", "GET");
    expect(first.value.data).toMatchObject({
      items: [{ name: "系统默认 Agent", recordKind: "system_default", deletable: false }],
    });
    expect((repeated.value.data as { items: unknown[] }).items).toHaveLength(1);
  });
});

/** 构造「json」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async function json(api: ControlApi, path: string, method: string, body?: unknown) {
  const response = await api.fetch(new Request(`http://127.0.0.1/api/control/v1${path}`, {
    method,
    headers: { origin: "http://127.0.0.1:5174", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  if (!response) throw new Error("expected response");
  return { response, value: await response.json() as { data: unknown } };
}
