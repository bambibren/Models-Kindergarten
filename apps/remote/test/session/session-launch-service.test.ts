import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PRODUCT_CONFIG } from "@kindergarten/contracts";
import { AgentRepository } from "../../src/agent/agent-repository.js";
import { AgentService } from "../../src/agent/agent-service.js";
import { FixtureProvider } from "../../src/model/fixture-provider.js";
import { ModelStudentCatalog } from "../../src/model/model-student-catalog.js";
import { SessionLaunchService } from "../../src/session/session-launch-service.js";

const dirs: string[] = [];
afterEach(/** 在每个测试后释放临时资源，保证后续场景从干净状态开始。 */
async () => Promise.all(dirs.splice(0).map(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(dir) => rm(dir, { recursive: true, force: true }))));

describe("SessionLaunchService reasoning override", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("只持久化具体档位，auto 必须由调用方省略", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const dir = await mkdtemp(join(tmpdir(), "mk-session-launch-"));
    dirs.push(dir);
    const agents = new AgentService(new AgentRepository(join(dir, "agents.json")), {
      builtinToolIds: /** 构造「builtinToolIds」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => [], readySkillInstallationIds: /** 构造「readySkillInstallationIds」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => [], mcpCapabilities: /** 构造「mcpCapabilities」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => [],
    });
    const agent = await agents.create({
      name: "Agent",
      systemPrompt: "test",
      builtinTools: [],
      skillInstallationIds: [],
      mcps: [],
      historyPolicy: { mode: "none" },
      memoryPolicy: { mode: "off" },
    });
    const models = new ModelStudentCatalog(new FixtureProvider(), "ready");
    const service = new SessionLaunchService(join(dir, "launches.json"), agents, models);
    const base = { modelStudentId: "fixture-student", agentId: agent.agentId, promptText: "开始" };

    await expect(service.create({ ...base, reasoningProfileOverride: "auto" }))
      .rejects.toThrow("reasoningProfileOverride 格式无效");
    expect(await service.create({ ...base, reasoningProfileOverride: "deep" }))
      .toMatchObject({ reasoningProfileOverride: "deep" });
    const created = await service.create(base);
    expect(created).not.toHaveProperty("reasoningProfileOverride");
    expect(Date.parse(created.expiresAt) - Date.parse(created.createdAt))
      .toBe(PRODUCT_CONFIG.sessionLaunch.draftTtlMs);
  });

  it("在主页启动草稿中只保存 Artifact 的稳定 ID", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const dir = await mkdtemp(join(tmpdir(), "mk-session-launch-mention-"));
    dirs.push(dir);
    const agents = new AgentService(new AgentRepository(join(dir, "agents.json")), {
      builtinToolIds: /** 构造「builtinToolIds」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => [], readySkillInstallationIds: /** 构造「readySkillInstallationIds」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => [], mcpCapabilities: /** 构造「mcpCapabilities」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => [],
    });
    const agent = await agents.create({
      name: "Agent", systemPrompt: "test", builtinTools: [], skillInstallationIds: [], mcps: [],
      historyPolicy: { mode: "none" }, memoryPolicy: { mode: "off" },
    });
    const service = new SessionLaunchService(join(dir, "launches.json"), agents, new ModelStudentCatalog(new FixtureProvider(), "ready"));
    const base = { modelStudentId: "fixture-student", agentId: agent.agentId, promptText: "使用已有海报" };

    const created = await service.create({ ...base, artifactMentions: [{ artifactId: "artifact_12345678" }] });
    expect(created.artifactMentions).toEqual([{ artifactId: "artifact_12345678" }]);
    expect((await service.get(created.launchId)).artifactMentions).toEqual([{ artifactId: "artifact_12345678" }]);
    await expect(service.create({ ...base, artifactMentions: [{ displayName: "伪造展示字段" }] }))
      .rejects.toThrow("artifactMentions 格式无效");
  });

  it("读取过期草稿时返回 410 并同步清理持久化记录", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const dir = await mkdtemp(join(tmpdir(), "mk-session-launch-expired-"));
    dirs.push(dir);
    const file = join(dir, "launches.json");
    await writeFile(file, JSON.stringify({ schemaVersion: 1, records: [{
      schemaVersion: 1,
      launchId: "expired-launch",
      ownerId: "local-admin",
      modelStudentId: "fixture-student",
      agentId: "agent",
      promptText: "旧任务",
      createdAt: "2020-01-01T00:00:00.000Z",
      expiresAt: "2020-01-01T00:01:00.000Z",
    }] }), "utf8");
    const agents = new AgentService(new AgentRepository(join(dir, "agents.json")), {
      builtinToolIds: /** 构造「builtinToolIds」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => [], readySkillInstallationIds: /** 构造「readySkillInstallationIds」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => [], mcpCapabilities: /** 构造「mcpCapabilities」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => [],
    });
    const service = new SessionLaunchService(file, agents, new ModelStudentCatalog(new FixtureProvider(), "ready"));

    await expect(service.get("expired-launch")).rejects.toMatchObject({ status: 410 });
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ records: [] });
  });
});
