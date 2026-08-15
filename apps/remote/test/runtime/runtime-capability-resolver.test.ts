import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRepository } from "../../src/agent/agent-repository.js";
import { AgentService } from "../../src/agent/agent-service.js";
import { RuntimeCapabilityResolver } from "../../src/capability/runtime-capability-resolver.js";
import { McpClientManager } from "../../src/mcp/mcp-client-manager.js";
import { McpConfigStore } from "../../src/mcp/mcp-config-store.js";
import type { McpConnector } from "../../src/mcp/mcp-types.js";
import { HostSecretStore } from "../../src/mcp/secret-store.js";
import { FixtureProvider } from "../../src/model/fixture-provider.js";
import { ModelStudentCatalog } from "../../src/model/model-student-catalog.js";
import { SkillLockStore } from "../../src/skills/skill-lock-store.js";
import { SkillRegistry } from "../../src/skills/skill-registry.js";
import type { TurnScope } from "../../src/runtime/turn-scope.js";
import type { SessionEntry } from "../../src/repository/session-types.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("RuntimeCapabilityResolver", () => {
  it("按 Agent 过滤工具，并为每个 Session 创建独立 workspace", async () => {
    const { resolver, agentId } = await setup();
    const first = await resolver.resolve(scope(agentId, "session-a"));
    const second = await resolver.resolve(scope(agentId, "session-b"));
    expect(first.tools.registry.definitions.map((item) => item.function.name)).toEqual(["read_file"]);
    expect(first.fileSandbox.root).not.toBe(second.fileSandbox.root);
    expect(first.fileSandbox.root).toContain("session-a");
    expect(first.agentSnapshotHash).toBe(second.agentSnapshotHash);
    expect(first.capabilityHash).toBe(second.capabilityHash);
  });

  it("Agent 保存后下一 Turn 使用新提示词和能力 hash", async () => {
    const { resolver, service, agentId } = await setup();
    const before = await resolver.resolve(scope(agentId, "session-a"));
    await service.update(agentId, agentInput("新提示词", true));
    const after = await resolver.resolve(scope(agentId, "session-a"));
    expect(after.agent.systemPrompt).toBe("新提示词");
    expect(after.agentSnapshotHash).not.toBe(before.agentSnapshotHash);
    expect(after.tools.registry.definitions.map((item) => item.function.name)).toEqual(["read_file", "write_file"]);
    expect(after.capabilityHash).not.toBe(before.capabilityHash);
  });

  it("按 Session 冻结的 modelStudentId 解析对应 Provider", async () => {
    const { service, skills, mcp, dir, agentId } = await setup();
    const fallback = new FixtureProvider();
    const selected = new AlternateFixtureProvider();
    const models = new ModelStudentCatalog(fallback, "ready");
    models.register(selected, { initialStatus: "ready" });
    const resolver = new RuntimeCapabilityResolver(service, models, skills, mcp, join(dir, "selected-workspaces"));

    const resolved = await resolver.resolve(scope(agentId, "session-selected", selected.student.id));
    expect(resolved.model).toBe(selected);
    await expect(resolver.resolve(scope(agentId, "session-missing", "missing-student"))).rejects.toThrow("不存在");
  });

  it("把 Provider 总消息上限换算为 ContextAssembler 首轮容量并预留 Tool 闭环", async () => {
    const { service, skills, mcp, dir, agentId } = await setup();
    const constrained = new ConstrainedFixtureProvider();
    const models = new ModelStudentCatalog(constrained, "ready");
    const resolver = new RuntimeCapabilityResolver(
      service,
      models,
      skills,
      mcp,
      join(dir, "limited-workspaces"),
    );
    const resolved = await resolver.resolve(
      scope(agentId, "session-limited", constrained.student.id),
    );
    const built = await resolved.context.buildObserved(
      longHistory(20),
      "current-message",
      new AbortController().signal,
    );

    // 10 total - 1 adapter system - 2 first tool-round headroom = 7.
    expect(built.messages).toHaveLength(7);
    expect(built.messages.at(-1)).toMatchObject({
      role: "user",
      content: "current-message",
    });
  });
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "mk-resolver-"));
  dirs.push(dir);
  const repository = new AgentRepository(join(dir, "agents.json"));
  const service = new AgentService(repository, {
    builtinToolIds: () => ["read_file", "write_file"],
    readySkillInstallationIds: () => [],
    mcpCapabilities: () => [],
  });
  const agent = await service.create(agentInput("初始提示词", false));
  const mcp = new McpClientManager(
    new McpConfigStore(join(dir, "mcp.json")),
    new HostSecretStore(),
    { connect: async () => { throw new Error("不会连接"); } } satisfies McpConnector,
  );
  await mcp.initialize();
  const skills = new SkillRegistry([], new SkillLockStore(join(dir, "skills-lock.json")));
  await skills.initialize();
  const resolver = new RuntimeCapabilityResolver(service, new FixtureProvider(), skills, mcp, join(dir, "workspaces"));
  return { resolver, service, skills, mcp, dir, agentId: agent.agentId };
}

function agentInput(systemPrompt: string, write: boolean) {
  return {
    name: "测试 Agent",
    systemPrompt,
    builtinTools: [
      { toolId: "read_file", enabled: true, permission: "allow" as const },
      { toolId: "write_file", enabled: write, permission: "ask" as const },
    ],
    skillInstallationIds: [], mcps: [],
    historyPolicy: { mode: "recent_turns" as const, maxTurns: 4 }, memoryPolicy: { mode: "off" as const },
  };
}

function scope(agentId: string, sessionId: string, modelStudentId = "fixture-student"): TurnScope {
  return {
    schemaVersion: 1,
    ownerId: "local-admin",
    sessionId,
    turnId: `turn-${sessionId}`,
    purpose: "chat",
    modelStudentId,
    agentId,
  };
}

class AlternateFixtureProvider extends FixtureProvider {
  override readonly student = {
    id: "alternate-student",
    name: "Alternate Student",
    sizeClass: "large" as const,
    provider: {
      kind: "openai-compatible" as const,
      model: "alternate",
      baseUrl: "https://api.example.test/v1",
    },
    generationDefaults: {},
  };
}

class ConstrainedFixtureProvider extends FixtureProvider {
  override readonly student = {
    id: "constrained-student",
    name: "Constrained Student",
    sizeClass: "large" as const,
    provider: {
      kind: "siliconflow" as const,
      model: "same-model",
      baseUrl: "https://api.siliconflow.cn/v1",
    },
    generationDefaults: {},
  };
  readonly inputMessageLimits = {
    maxMessages: 10,
    adapterReservedMessages: 1,
    initialToolRoundHeadroom: 2,
  } as const;
}

function longHistory(count: number): SessionEntry[] {
  const createdAt = new Date("2026-08-14T00:00:00.000Z").toISOString();
  return Array.from({ length: count }, (_, index) => ({
    type: "message" as const,
    role: index % 2 === 0 ? "user" as const : "assistant" as const,
    text: `history-${index}`,
    turnId: `history-turn-${Math.floor(index / 2)}`,
    messageId: `history-message-${index}`,
    createdAt,
  }));
}
