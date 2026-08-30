import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRepository } from "../../src/agent/agent-repository.js";
import { AgentService } from "../../src/agent/agent-service.js";
import { RuntimeCapabilityResolver } from "../../src/capability/runtime-capability-resolver.js";
import { McpClientManager } from "../../src/mcp/mcp-client-manager.js";
import { McpConfigStore } from "../../src/mcp/mcp-config-store.js";
import type { McpConnector } from "../../src/mcp/mcp-types.js";
import { testSecretStore } from "../support/test-secret-store.js";
import { FixtureProvider } from "../../src/model/fixture-provider.js";
import { ModelStudentCatalog } from "../../src/model/model-student-catalog.js";
import { SkillLockStore } from "../../src/skills/skill-lock-store.js";
import { SkillRegistry } from "../../src/skills/skill-registry.js";
import type { TurnScope } from "../../src/runtime/turn-scope.js";
import type { SessionEntry } from "../../src/repository/session-types.js";

const dirs: string[] = [];
afterEach(/** 在每个测试后释放临时资源，保证后续场景从干净状态开始。 */
async () => Promise.all(dirs.splice(0).map(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(dir) => rm(dir, { recursive: true, force: true }))));

describe("RuntimeCapabilityResolver", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("按 Agent 过滤工具，并为每个 Session 创建独立 workspace", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const { resolver, agentId } = await setup();
    const first = await resolver.resolve(scope(agentId, "session-a"));
    const second = await resolver.resolve(scope(agentId, "session-b"));
    expect(first.tools.registry.definitions.map(/** 构造「toEqual」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(item) => item.function.name)).toEqual(["read_file"]);
    expect(first.fileSandbox.root).not.toBe(second.fileSandbox.root);
    expect(first.fileSandbox.root).toContain("session-a");
    expect(first.agentSnapshotHash).toBe(second.agentSnapshotHash);
    expect(first.capabilityHash).toBe(second.capabilityHash);
  });

  it("Agent 保存后下一 Turn 使用新提示词和能力 hash", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const { resolver, service, agentId } = await setup();
    const before = await resolver.resolve(scope(agentId, "session-a"));
    await service.update(agentId, agentInput("新提示词", true));
    const after = await resolver.resolve(scope(agentId, "session-a"));
    expect(after.agent.systemPrompt).toBe("新提示词");
    expect(after.agentSnapshotHash).not.toBe(before.agentSnapshotHash);
    expect(after.tools.registry.definitions.map(/** 构造「toEqual」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(item) => item.function.name)).toEqual(["read_file", "write_file", "edit_file"]);
    expect(after.capabilityHash).not.toBe(before.capabilityHash);
  });

  it("直接解析全局 Builtin Skill，不经过账号 Installation", async () => {
    const { resolver, service, agentId } = await setup();
    await service.update(agentId, agentInput("启用内置 Skill", false, false, ["builtin:sandbox-notes"]));

    const resolved = await resolver.resolve(scope(agentId, "session-builtin"));

    expect(resolved.agent.builtinSkills).toEqual([{ skillId: "builtin:sandbox-notes", enabled: true }]);
    expect(resolved.agent.skills).toEqual([]);
    expect(resolved.tools.registry.definitions.map((item) => item.function.name)).toEqual(expect.arrayContaining([
      "activate_skill",
      "read_skill_resource",
    ]));
    expect(resolved.tools.registry.capabilitySnapshot().skills).toEqual([
      expect.objectContaining({ name: "sandbox-notes", source: "builtin" }),
    ]);
  });

  it("build_pptx 只在 Agent 明确启用时进入当前 Turn 能力快照", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const { resolver, service, agentId } = await setup();
    const before = await resolver.resolve(scope(agentId, "session-pptx-before"));
    expect(before.tools.registry.definitions.map(/** 构造「not」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(item) => item.function.name)).not.toContain("build_pptx");

    await service.update(agentId, agentInput("PPTX Agent", false, true));
    const after = await resolver.resolve(scope(agentId, "session-pptx-after"));
    expect(after.tools.registry.definitions.map(/** 构造「toContain」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(item) => item.function.name)).toContain("build_pptx");
    expect(after.tools.registry.capabilitySnapshot().tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "pptx:tool:build_pptx", modelName: "build_pptx", origin: "builtin" }),
    ]));
  });

  it("按 Session 冻结的 modelStudentId 解析对应 Provider", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
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

  it("把 Provider 总消息上限换算为 ContextAssembler 首轮容量并预留 Tool 闭环", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
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

    // 总额 10，扣除 1 条 Adapter system 消息和首轮 Tool 所需 2 条预留，实际历史预算为 7。
    expect(built.messages).toHaveLength(7);
    expect(built.messages.at(-1)).toMatchObject({
      role: "user",
      content: "current-message",
    });
  });
});

/** 构造「setup」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "mk-resolver-"));
  dirs.push(dir);
  const builtinRoot = join(dir, "builtin-skills");
  const sandboxNotes = join(builtinRoot, "sandbox-notes");
  await mkdir(sandboxNotes, { recursive: true });
  await writeFile(join(sandboxNotes, "SKILL.md"), "---\nname: sandbox-notes\ndescription: 记录沙箱笔记\n---\n\n记录任务笔记。\n");
  const skills = new SkillRegistry([{
    path: builtinRoot, scope: "builtin", trust: "builtin", source: "builtin",
  }], new SkillLockStore(join(dir, "skills-lock.json")));
  await skills.initialize();
  const repository = new AgentRepository(join(dir, "agents.json"));
  const service = new AgentService(repository, {
    builtinToolIds: /** 构造「builtinToolIds」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => ["read_file", "write_file", "build_pptx"],
    builtinSkills: () => skills.builtinOptions(),
    readySkillInstallationIds: /** 构造「readySkillInstallationIds」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => Promise.resolve([]),
    mcpCapabilities: /** 构造「mcpCapabilities」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => Promise.resolve([]),
  });
  const agent = await service.create(agentInput("初始提示词", false));
  const mcp = new McpClientManager(
    new McpConfigStore(join(dir, "mcp.json")),
    testSecretStore(),
    { connect: /** 构造「connect」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => { throw new Error("不会连接"); } } satisfies McpConnector,
  );
  await mcp.initialize();
  const resolver = new RuntimeCapabilityResolver(service, new FixtureProvider(), skills, mcp, join(dir, "workspaces"));
  return { resolver, service, skills, mcp, dir, agentId: agent.agentId };
}

/** 构造「agentInput」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function agentInput(systemPrompt: string, write: boolean, pptx = false, builtinSkillIds: string[] = []) {
  return {
    name: "测试 Agent",
    systemPrompt,
    builtinTools: [
      { toolId: "read_file", enabled: true, permission: "allow" as const },
      { toolId: "write_file", enabled: write, permission: "ask" as const },
      { toolId: "build_pptx", enabled: pptx, permission: "allow" as const },
    ],
    builtinSkillIds,
    skillInstallationIds: [], mcps: [],
    historyPolicy: { mode: "recent_turns" as const, maxTurns: 4 }, memoryPolicy: { mode: "off" as const },
  };
}

/** 构造「scope」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
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

/** 构造「longHistory」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function longHistory(count: number): SessionEntry[] {
  const createdAt = new Date("2026-08-14T00:00:00.000Z").toISOString();
  return Array.from({ length: count }, /** 构造「longHistory」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(_, index) => ({
    type: "message" as const,
    role: index % 2 === 0 ? "user" as const : "assistant" as const,
    text: `history-${index}`,
    turnId: `history-turn-${Math.floor(index / 2)}`,
    messageId: `history-message-${index}`,
    createdAt,
  }));
}
