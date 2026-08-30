import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRepository } from "../../src/agent/agent-repository.js";
import { AgentService } from "../../src/agent/agent-service.js";

const dirs: string[] = [];

afterEach(/** 在每个测试后释放临时资源，保证后续场景从干净状态开始。 */
async () => Promise.all(dirs.splice(0).map(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(dir) => rm(dir, { recursive: true, force: true }))));

describe("AgentService", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("创建、查询、全量覆盖并以内部分支合并 Skill", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
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

  it("为每个账号幂等创建一个不绑定模型且不可删除的系统默认 Agent", async () => {
    const service = await makeService();
    const [first, repeated] = await Promise.all([
      service.ensureDefault(input("系统默认 Agent"), "user-1"),
      service.ensureDefault(input("系统默认 Agent"), "user-1"),
    ]);
    const anotherOwner = await service.ensureDefault(input("系统默认 Agent"), "user-2");

    expect(repeated.agentId).toBe(first.agentId);
    expect(first).toMatchObject({
      ownerId: "user-1",
      recordKind: "system_default",
      name: "系统默认 Agent",
      deletable: false,
    });
    expect(first).not.toHaveProperty("modelStudentId");
    expect(anotherOwner.agentId).not.toBe(first.agentId);
    expect((await service.list({}, "user-1")).items).toHaveLength(1);
    expect((await service.list({}, "user-2")).items).toHaveLength(1);
    await expect(service.delete(first.agentId, "user-1")).rejects.toThrow("系统内置 Agent 不可删除");
  });

  it("把账号下同名的历史默认 Agent 提升为系统默认记录", async () => {
    const service = await makeService();
    const legacy = await service.create(input("系统默认 Agent"), "user-1");
    const ensured = await service.ensureDefault(input("系统默认 Agent"), "user-1");

    expect(ensured).toMatchObject({
      agentId: legacy.agentId,
      ownerId: "user-1",
      recordKind: "system_default",
      deletable: false,
    });
    expect((await service.list({}, "user-1")).items).toHaveLength(1);
  });

  it("拒绝不存在的 built-in、Skill 和 MCP capability 引用", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const service = await makeService();
    await expect(service.create({ ...input("bad"), builtinTools: [{ toolId: "unknown", enabled: true, permission: "allow" }] }))
      .rejects.toThrow("CAPABILITY_REFERENCE_INVALID");
    await expect(service.create({ ...input("bad"), builtinSkillIds: ["builtin:missing"] }))
      .rejects.toThrow("Builtin Skill 不存在");
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

  it("拒绝绑定其他账号拥有的 Skill 和 MCP Installation", async () => {
    const service = await makeService();
    await expect(service.create({
      ...input("跨账号 Skill"),
      skillInstallationIds: ["skill-1"],
    }, "user-2")).rejects.toThrow("Skill Installation 不可用");
    await expect(service.create({
      ...input("跨账号 MCP"),
      mcps: [{
        mcpInstallationId: "mcp-1",
        enabled: true,
        tools: [{ remoteName: "search", enabled: true, permission: "allow" }],
        resources: [],
      }],
    }, "user-2")).rejects.toThrow("MCP Installation 不可用");
  });

  it("清理历史 Agent 中不属于当前账号的 Skill 和 MCP 引用", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mk-agent-reconcile-"));
    dirs.push(dir);
    const repository = new AgentRepository(join(dir, "agents.json"));
    const now = new Date().toISOString();
    await repository.insert({
      schemaVersion: 1,
      agentId: "legacy-owner-b",
      ownerId: "user-2",
      recordKind: "system_default",
      name: "系统默认 Agent",
      systemPrompt: "test",
      builtinTools: [],
      builtinSkills: [],
      skills: [{ skillInstallationId: "skill-owner-a", enabled: true }],
      mcps: [{ mcpInstallationId: "mcp-owner-a", enabled: true, tools: [], resources: [] }],
      historyPolicy: { mode: "none" },
      memoryPolicy: { mode: "off" },
      createdAt: now,
      updatedAt: now,
    });
    const service = new AgentService(repository, {
      builtinToolIds: () => [],
      readySkillInstallationIds: () => Promise.resolve([]),
      mcpCapabilities: () => Promise.resolve([]),
    });

    const repaired = await service.reconcileCapabilities("user-2");

    expect(repaired).toHaveLength(1);
    expect(await service.get("legacy-owner-b", "user-2")).toMatchObject({ skills: [], mcps: [] });
  });

  it("保留当前账号仍拥有但暂不可用的 Skill 和 MCP 引用", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mk-agent-disabled-assets-"));
    dirs.push(dir);
    const repository = new AgentRepository(join(dir, "agents.json"));
    const now = new Date().toISOString();
    await repository.insert({
      schemaVersion: 1,
      agentId: "agent-disabled-assets",
      ownerId: "owner-a",
      recordKind: "user",
      name: "保留禁用资产",
      systemPrompt: "test",
      builtinTools: [],
      builtinSkills: [],
      skills: [{ skillInstallationId: "skill-disabled", enabled: true }],
      mcps: [{ mcpInstallationId: "mcp-disabled", enabled: true, tools: [], resources: [] }],
      historyPolicy: { mode: "none" },
      memoryPolicy: { mode: "off" },
      createdAt: now,
      updatedAt: now,
    });
    const service = new AgentService(repository, {
      builtinToolIds: () => [],
      readySkillInstallationIds: () => Promise.resolve([]),
      mcpCapabilities: () => Promise.resolve([]),
      skillInstallationIds: () => Promise.resolve(["skill-disabled"]),
      mcpInstallationIds: () => Promise.resolve(["mcp-disabled"]),
    });

    expect(await service.reconcileCapabilities("owner-a")).toEqual([]);
    expect(await service.get("agent-disabled-assets", "owner-a")).toMatchObject({
      skills: [{ skillInstallationId: "skill-disabled" }],
      mcps: [{ mcpInstallationId: "mcp-disabled" }],
    });
  });

  it("列表支持搜索、cursor 分页且后一次成功保存生效", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
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

  it("保存 Agent 时不改写前端提交的写文件权限", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
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

  it("拒绝仍携带 Agent 推理默认值的旧记录", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
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

/** 构造「makeService」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async function makeService(): Promise<AgentService> {
  const dir = await mkdtemp(join(tmpdir(), "mk-agents-"));
  dirs.push(dir);
  return new AgentService(new AgentRepository(join(dir, "agents.json")), {
    builtinToolIds: /** 构造「builtinToolIds」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => ["read_file", "write_file"],
    builtinSkills: () => [{ skillId: "builtin:sandbox-notes", name: "sandbox-notes", description: "记录沙箱笔记" }],
    readySkillInstallationIds: /** 构造「readySkillInstallationIds」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(ownerId) => Promise.resolve(ownerId === "local-admin" ? ["skill-1"] : []),
    mcpCapabilities: /** 构造「mcpCapabilities」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(ownerId) => Promise.resolve(ownerId === "local-admin"
      ? [{ installationId: "mcp-1", tools: ["search"], resources: ["docs://index"] }]
      : []),
  });
}

/** 构造「input」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function input(name: string) {
  return {
    name,
    systemPrompt: "先检查再回答",
    builtinTools: [{ toolId: "read_file", enabled: true, permission: "allow" as const }],
    builtinSkillIds: [],
    skillInstallationIds: [],
    mcps: [],
    historyPolicy: { mode: "recent_turns" as const, maxTurns: 6 },
    memoryPolicy: { mode: "off" as const },
  };
}
