import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRepository } from "../../src/agent/agent-repository.js";
import { AgentService } from "../../src/agent/agent-service.js";

const dirs: string[] = [];

afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("AgentService", () => {
  it("创建、查询、全量覆盖并以内部分支合并 Skill", async () => {
    const service = await makeService();
    const created = await service.create(input("初始 Agent"));
    expect(created.agentId).toBeTruthy();
    expect(created.ownerId).toBe("local-admin");
    expect(created).not.toHaveProperty("defaultReasoningProfile");
    expect(await service.get(created.agentId)).toEqual(created);

    const updated = await service.update(created.agentId, input("后一次保存"));
    expect(updated.name).toBe("后一次保存");
    expect(updated).not.toHaveProperty("version");
    expect(updated).not.toHaveProperty("revision");

    const merged = await service.mergeReadySkills(created.agentId, ["skill-1", "skill-1"]);
    expect(merged.skills).toEqual([{ skillInstallationId: "skill-1", enabled: true }]);
  });

  it("拒绝不存在的 built-in、Skill 和 MCP capability 引用", async () => {
    const service = await makeService();
    await expect(service.create({ ...input("bad"), builtinTools: [{ toolId: "unknown", enabled: true, permission: "allow" }] }))
      .rejects.toThrow("CAPABILITY_REFERENCE_INVALID");
    await expect(service.create({ ...input("bad"), skillInstallationIds: ["missing-skill"] }))
      .rejects.toThrow("CAPABILITY_REFERENCE_INVALID");
    await expect(service.create({
      ...input("bad"),
      mcps: [{
        mcpInstallationId: "mcp-1",
        enabled: true,
        tools: [{ remoteName: "missing", enabled: true, permission: "allow" }],
        resources: [],
      }],
    })).rejects.toThrow("CAPABILITY_REFERENCE_INVALID");
  });

  it("列表支持搜索、cursor 分页且后一次成功保存生效", async () => {
    const service = await makeService();
    await service.create(input("代码助手"));
    await service.create(input("研究助手"));
    await service.create(input("代码审查"));
    const first = await service.list({ query: "代码", limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    if (!first.nextCursor) throw new Error("expected nextCursor");
    const second = await service.list({ query: "代码", limit: 1, cursor: first.nextCursor });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.agentId).not.toBe(first.items[0]?.agentId);
  });

  it("保存 Agent 时不改写前端提交的写文件权限", async () => {
    const service = await makeService();
    const created = await service.create({
      ...input("权限配置"),
      builtinTools: [{ toolId: "write_file", enabled: true, permission: "ask" }],
    });
    expect(created.builtinTools).toEqual([
      { toolId: "write_file", enabled: true, permission: "ask" },
    ]);

    const updated = await service.update(created.agentId, {
      ...input("权限配置"),
      builtinTools: [{ toolId: "write_file", enabled: true, permission: "allow" }],
    });
    expect(updated.builtinTools).toEqual([
      { toolId: "write_file", enabled: true, permission: "allow" },
    ]);
  });

  it("拒绝仍携带 Agent 推理默认值的旧记录", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mk-agents-legacy-"));
    dirs.push(dir);
    const file = join(dir, "agents.json");
    const base = {
      schemaVersion: 1,
      agentId: "legacy-agent",
      ownerId: "local-admin",
      name: "Legacy",
      systemPrompt: "legacy",
      builtinTools: [],
      skills: [],
      mcps: [],
      historyPolicy: { mode: "none" },
      memoryPolicy: { mode: "off" },
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z",
    };
    await writeFile(file, JSON.stringify({ schemaVersion: 1, records: [{ ...base, defaultReasoningProfile: "xhigh" }] }), "utf8");
    await expect(new AgentRepository(file).get("legacy-agent")).rejects.toThrow("record[0] 格式无效");
  });
});

async function makeService(): Promise<AgentService> {
  const dir = await mkdtemp(join(tmpdir(), "mk-agents-"));
  dirs.push(dir);
  return new AgentService(new AgentRepository(join(dir, "agents.json")), {
    builtinToolIds: () => ["read_file", "write_file"],
    readySkillInstallationIds: () => ["skill-1"],
    mcpCapabilities: () => [{ installationId: "mcp-1", tools: ["search"], resources: ["docs://index"] }],
  });
}

function input(name: string) {
  return {
    name,
    systemPrompt: "先检查再回答",
    builtinTools: [{ toolId: "read_file", enabled: true, permission: "allow" as const }],
    skillInstallationIds: [],
    mcps: [],
    historyPolicy: { mode: "recent_turns" as const, maxTurns: 6 },
    memoryPolicy: { mode: "off" as const },
  };
}
