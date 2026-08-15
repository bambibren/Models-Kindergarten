import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRepository } from "../../src/agent/agent-repository.js";
import { registerAgentRoutes } from "../../src/agent/agent-routes.js";
import { AgentService } from "../../src/agent/agent-service.js";
import { ControlApi } from "../../src/server/control-api.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("Agent routes", () => {
  it("提供 Agent create/get/list/update/delete，但没有归档或迁移", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mk-agent-routes-"));
    dirs.push(dir);
    const api = new ControlApi({ allowedOrigins: ["http://127.0.0.1:5174"] });
    const service = new AgentService(new AgentRepository(join(dir, "agents.json")), {
      builtinToolIds: () => ["read_file"], readySkillInstallationIds: () => [], mcpCapabilities: () => [],
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

  it("系统默认 Agent 不暴露删除能力且接口拒绝删除", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mk-agent-protected-"));
    dirs.push(dir);
    const api = new ControlApi({ allowedOrigins: ["http://127.0.0.1:5174"] });
    const service = new AgentService(new AgentRepository(join(dir, "agents.json")), {
      builtinToolIds: () => [], readySkillInstallationIds: () => [], mcpCapabilities: () => [],
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
});

async function json(api: ControlApi, path: string, method: string, body?: unknown) {
  const response = await api.fetch(new Request(`http://127.0.0.1/api/control/v1${path}`, {
    method,
    headers: { origin: "http://127.0.0.1:5174", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  if (!response) throw new Error("expected response");
  return { response, value: await response.json() as { data: unknown } };
}
