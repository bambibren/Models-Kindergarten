import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRepository } from "../../src/agent/agent-repository.js";
import { AgentService } from "../../src/agent/agent-service.js";
import { FixtureProvider } from "../../src/model/fixture-provider.js";
import { ModelStudentCatalog } from "../../src/model/model-student-catalog.js";
import { SessionLaunchService } from "../../src/session/session-launch-service.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("SessionLaunchService reasoning override", () => {
  it("只持久化具体档位，auto 必须由调用方省略", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mk-session-launch-"));
    dirs.push(dir);
    const agents = new AgentService(new AgentRepository(join(dir, "agents.json")), {
      builtinToolIds: () => [], readySkillInstallationIds: () => [], mcpCapabilities: () => [],
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
    expect(await service.create(base)).not.toHaveProperty("reasoningProfileOverride");
  });
});
