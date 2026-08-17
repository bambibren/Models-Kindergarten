import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PRODUCT_CONFIG } from "@kindergarten/contracts";
import { AgentRepository } from "../../src/agent/agent-repository.js";
import { AgentService } from "../../src/agent/agent-service.js";
import {
  buildGitEnvironment,
  parseMacOSHttpsProxy,
  processTreeTermination,
  runGitCommand,
} from "../../src/git/git-command-runner.js";
import { EnsureAgentSkillsToolProvider } from "../../src/skills/ensure-agent-skills-tool.js";
import { explicitGitHubSkillUrls, parseGitHubSkillUrl } from "../../src/skills/github-skill-source.js";
import {
  discoverSkillDirectoriesAtFirstDepth,
  discoverSkillDirectoriesFromGitTree,
  type SkillDiscoveryPort,
} from "../../src/skills/skill-discovery.js";
import { SkillInstallationRepository } from "../../src/skills/skill-installation-repository.js";
import { SkillInstallationService, type SkillInstallerPort } from "../../src/skills/skill-installation-service.js";
import { SkillLockStore } from "../../src/skills/skill-lock-store.js";
import { SkillRegistry } from "../../src/skills/skill-registry.js";
import { SkillSourceUrlPolicy } from "../../src/skills/skill-source-url.js";
import type { TurnScope } from "../../src/runtime/turn-scope.js";
import { ToolCallLedger, ToolRuntime, type ToolObserver } from "../../src/tools/tool-runtime.js";

const dirs: string[] = [];
const URL_A = "https://github.com/acme/skills/tree/main/frontend-design";
const REPOSITORY_URL = "https://github.com/greensock/gsap-skills";
const RESOURCE_ORIGIN = "http://127.0.0.1:7342";
const RESOURCE_URL = `${RESOURCE_ORIGIN}/skills/website-design-fast`;

afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("Skill Installation", () => {
  it("从当前用户消息提取仓库根地址或明确 Skill 目录地址", () => {
    expect(explicitGitHubSkillUrls(`请设计网页 ${URL_A}`)).toEqual([URL_A]);
    expect(explicitGitHubSkillUrls(`请安装 ${REPOSITORY_URL}`)).toEqual([REPOSITORY_URL]);
    expect(explicitGitHubSkillUrls(`请安装 ${REPOSITORY_URL}.git/`)).toEqual([REPOSITORY_URL]);
    expect(explicitGitHubSkillUrls("请设计网页，帮我找个合适 Skill")).toEqual([]);
    expect(() => parseGitHubSkillUrl("https://example.com/a/tree/main/skill")).toThrow("SKILL_SOURCE_NOT_ALLOWED");
    expect(parseGitHubSkillUrl(REPOSITORY_URL)).toMatchObject({ kind: "repository", repository: REPOSITORY_URL });
    expect(parseGitHubSkillUrl(`${REPOSITORY_URL}.git`)).toMatchObject({
      kind: "repository",
      sourceUrl: REPOSITORY_URL,
      repository: REPOSITORY_URL,
      cloneUrl: `${REPOSITORY_URL}.git`,
    });
    expect(parseGitHubSkillUrl(URL_A)).toMatchObject({ kind: "tree", source: { requestedRef: "main", subdirectory: "frontend-design" } });
  });

  it("模糊提示不暴露 ensure tool，显式 URL 才暴露", async () => {
    const { service, scope } = await setup();
    expect(new EnsureAgentSkillsToolProvider(service, scope, "帮我设计网页").definitions).toHaveLength(0);
    expect(new EnsureAgentSkillsToolProvider(service, scope, `请安装 ${URL_A}`).definitions[0]?.function.name)
      .toBe("ensure_agent_skills");
  });

  it("只从配置允许的静态资源源站提取并安装 Skill", async () => {
    const { service, scope, installer, agents } = await setup([], [RESOURCE_ORIGIN]);
    const provider = new EnsureAgentSkillsToolProvider(service, scope, `请安装 ${RESOURCE_URL}`);
    const parameters = provider.definitions[0]?.function.parameters as {
      properties?: { source_urls?: { items?: { enum?: string[] } } };
    };
    expect(parameters.properties?.source_urls?.items?.enum).toEqual([RESOURCE_URL]);
    expect(service.explicitSourceUrlCandidates("请安装 http://127.0.0.1:9999/skills/website-design-fast")).toEqual([]);

    vi.mocked(installer.install).mockResolvedValueOnce(installedResource("website-design-fast"));
    const job = await service.ensureForTurn(
      { sourceUrls: [RESOURCE_URL], mode: "ensure" },
      scope,
      `请安装 ${RESOURCE_URL}`,
    );

    expect(installer.install).toHaveBeenCalledWith({
      approved: true,
      source: { kind: "resource", url: RESOURCE_URL },
    }, { replaceExisting: false });
    expect(job.items[0]?.source).toEqual({
      kind: "resource_bundle",
      url: RESOURCE_URL,
      resolvedContentHash: "resource-hash",
    });
    expect((await agents.get(scope.agentId)).skills).toHaveLength(1);
  });

  it("动态 Tool Schema 保留用户给出的原始 URL，模型继续传 source_urls 和 mode", async () => {
    const { service, scope } = await setup();
    const repositoryWithGit = `${REPOSITORY_URL}.git`;
    const provider = new EnsureAgentSkillsToolProvider(
      service,
      scope,
      `请安装 ${URL_A} 和 ${repositoryWithGit}`,
    );
    const parameters = provider.definitions[0]?.function.parameters as {
      properties?: {
        source_urls?: { items?: { enum?: string[] } };
        mode?: { enum?: string[] };
      };
      required?: string[];
    };

    expect(parameters.properties?.source_urls?.items?.enum).toEqual([URL_A, repositoryWithGit]);
    expect(parameters.properties?.mode?.enum).toEqual(["ensure"]);
    expect(parameters.required).toEqual(["source_urls", "mode"]);
  });

  it("参数错误保留原始错误，并追加当前用户消息生成的正确参数提示", async () => {
    const { service, scope } = await setup();
    const repositoryWithGit = `${REPOSITORY_URL}.git`;
    const allowed = [URL_A, repositoryWithGit];
    const provider = new EnsureAgentSkillsToolProvider(service, scope, `请安装 ${allowed.join(" 和 ")}`);
    const prepared = provider.prepare({
      id: "call-invalid-source",
      name: "ensure_agent_skills",
      arguments: {
        source_urls: [URL_A, REPOSITORY_URL],
        mode: "ensure",
      },
    }, "fallback");

    const result = await new ToolRuntime(provider).executeBatch(
      [prepared],
      observer(),
      new ToolCallLedger(),
      new AbortController().signal,
    );
    const outcome = result.outcomes[0];
    const raw = outcome?.rawOutput as {
      error?: { code?: string; category?: string; message?: string };
      argument_correction?: {
        message?: string;
        exact_retry_arguments?: { source_urls?: string[]; mode?: string };
      };
    };
    const model = JSON.parse(outcome?.modelContent ?? "{}") as typeof raw & { instruction?: string };

    expect(raw.error).toEqual({
      code: "invalid_arguments",
      category: "validation",
      message: `SKILL_SOURCE_NOT_USER_PROVIDED: ${REPOSITORY_URL}`,
    });
    expect(raw.argument_correction?.exact_retry_arguments).toEqual({ source_urls: allowed, mode: "ensure" });
    expect(raw.argument_correction?.message).toContain("必须原样使用 exact_retry_arguments");
    expect(model.error).toEqual(raw.error);
    expect(model.argument_correction).toEqual(raw.argument_correction);
    expect(model.instruction).toContain('"source_urls"');
    expect(model.instruction).toContain(repositoryWithGit);
    expect(model.instruction).toContain('"mode":"ensure"');
    expect(JSON.stringify(raw)).not.toContain("suggested_arguments");
  });

  it("下载失败保留原始领域错误，但不追加参数修改提示", async () => {
    const { service, scope, discovery } = await setup();
    vi.mocked(discovery.discoverGitHub).mockRejectedValue(new Error("curl 28: Failed to connect"));
    const provider = new EnsureAgentSkillsToolProvider(service, scope, `请安装 ${URL_A}`);
    const prepared = provider.prepare({
      id: "call-network-failure",
      name: "ensure_agent_skills",
      arguments: { source_urls: [URL_A], mode: "ensure" },
    }, "fallback");

    const result = await new ToolRuntime(provider).executeBatch(
      [prepared],
      observer(),
      new ToolCallLedger(),
      new AbortController().signal,
    );
    const outcome = result.outcomes[0];
    const raw = outcome?.rawOutput as {
      error?: { code?: string; category?: string; message?: string };
      argument_correction?: unknown;
    };
    const model = JSON.parse(outcome?.modelContent ?? "{}") as {
      error?: { code?: string; category?: string; message?: string };
      argument_correction?: unknown;
    };

    expect(raw.error).toMatchObject({
      code: "SKILL_JOB_INTERRUPTED",
      category: "network",
    });
    expect(raw.error?.message).toContain("下载失败");
    expect(raw.argument_correction).toBeUndefined();
    expect(model.error).toEqual(raw.error);
    expect(model.argument_correction).toBeUndefined();
  });

  it("只返回第一次命中 SKILL.md 深度的全部目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "mk-skill-depth-"));
    dirs.push(root);
    await Promise.all([
      mkdir(join(root, "skills", "core", "references"), { recursive: true }),
      mkdir(join(root, "skills", "timeline"), { recursive: true }),
      mkdir(join(root, "deeper", "level", "ignored"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(root, "skills", "core", "SKILL.md"), "core"),
      writeFile(join(root, "skills", "timeline", "SKILL.md"), "timeline"),
      writeFile(join(root, "skills", "core", "references", "SKILL.md"), "resource, not child skill"),
      writeFile(join(root, "deeper", "level", "ignored", "SKILL.md"), "too deep"),
    ]);
    expect(await discoverSkillDirectoriesAtFirstDepth(root)).toEqual([
      join(root, "skills", "core"),
      join(root, "skills", "timeline"),
    ]);
  });

  it("从 macOS 当前系统代理配置解析 Git HTTPS 代理，不写死端口", () => {
    expect(parseMacOSHttpsProxy("HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7892\n"))
      .toBe("http://127.0.0.1:7892");
    expect(parseMacOSHttpsProxy("HTTPSEnable : 0\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 9999\n"))
      .toBeUndefined();
  });

  it("所有 Git 阶段共用非交互、代理和低速中止配置", () => {
    expect(buildGitEnvironment({ PATH: "/usr/bin" }, "http://127.0.0.1:7892")).toMatchObject({
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://127.0.0.1:7892",
      HTTP_PROXY: "http://127.0.0.1:7892",
      GIT_TERMINAL_PROMPT: "0",
      GIT_HTTP_LOW_SPEED_LIMIT: "1024",
      GIT_HTTP_LOW_SPEED_TIME: "15",
    });
  });

  it("Git 阶段超时会终止命令而不是永久 pending", async () => {
    const startedAt = Date.now();
    await expect(runGitCommand(
      ["-c", "alias.wait=!sleep 5", "wait"],
      {
        env: buildGitEnvironment(process.env),
        timeoutMs: 100,
        label: "测试阶段",
      },
    )).rejects.toThrow("Git 测试阶段超时");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("Git 超时时按系统终止完整进程树", () => {
    expect(processTreeTermination("win32", 321)).toEqual({
      kind: "taskkill",
      command: "taskkill",
      args: ["/PID", "321", "/T", "/F"],
    });
    expect(processTreeTermination("darwin", 321)).toEqual({
      kind: "process_group",
      pid: -321,
    });
  });

  it("从 Git tree 元数据找第一次命中 SKILL.md 的深度，不先 checkout 全仓库", () => {
    expect(discoverSkillDirectoriesFromGitTree([
      "README.md",
      "skills/core/SKILL.md",
      "skills/core/references/SKILL.md",
      "skills/timeline/SKILL.md",
      "deeper/level/ignored/SKILL.md",
    ], ".")).toEqual(["skills/core", "skills/timeline"]);
    expect(discoverSkillDirectoriesFromGitTree([
      "skills/core/SKILL.md",
      "skills/core/references/SKILL.md",
      "skills/timeline/SKILL.md",
    ], "skills/core")).toEqual(["skills/core"]);
  });

  it("拒绝安装当前消息中未逐字出现的 URL", async () => {
    const { service, scope } = await setup();
    await expect(service.ensureForTurn({ sourceUrls: [URL_A], mode: "ensure" }, scope, "请设计网页"))
      .rejects.toMatchObject({ code: "SKILL_SOURCE_NOT_USER_PROVIDED" });
  });

  it("超过 Skill URL 上限时返回真实的资源限制，不报告格式错误", async () => {
    const { service, scope } = await setup();
    const urls = Array.from({ length: PRODUCT_CONFIG.skill.maxSourceUrlsPerJob + 1 }, (_, index) =>
      `https://github.com/acme/skills/tree/main/skill-${index}`);
    const provider = new EnsureAgentSkillsToolProvider(service, scope, `请安装 ${urls.join(" ")}`);
    const prepared = provider.prepare({
      id: "too-many-skill-urls",
      name: "ensure_agent_skills",
      arguments: { source_urls: urls, mode: "ensure" },
    }, "fallback");

    const result = await new ToolRuntime(provider).executeBatch(
      [prepared],
      observer(),
      new ToolCallLedger(),
      new AbortController().signal,
    );

    expect(result.outcomes[0]?.error).toEqual({
      code: "SKILL_SOURCE_URL_LIMIT_EXCEEDED",
      category: "resource_limit",
      message: `单次 Skill 安装最多接收 ${PRODUCT_CONFIG.skill.maxSourceUrlsPerJob} 个 URL；本次提供了 ${urls.length} 个`,
    });
  });

  it("下载 GitHub 失败时不向页面泄露本机命令和临时路径", async () => {
    const { service, scope, installer } = await setup();
    vi.mocked(installer.install).mockRejectedValue(new Error("Command failed: git clone https://github.com/acme/skills.git /Users/demo/.install-secret/repo\ncurl 28: Failed to connect"));
    await expect(service.ensureForTurn({ sourceUrls: [URL_A], mode: "ensure" }, scope, `安装 ${URL_A}`))
      .rejects.toMatchObject({
        code: "SKILL_JOB_INTERRUPTED",
        retryable: true,
        message: "GitHub 仓库地址格式已验证（.git 后缀合法）；连接 https://github.com/acme/skills.git 下载失败或超时，操作已终止，请稍后重新提交安装",
      });
  });

  it("仓库地址安装第一次发现 SKILL.md 深度的全部 Skills，不继续深入", async () => {
    const { service, scope, discovery, installer, agents } = await setup(["install-core", "install-timeline"]);
    vi.mocked(discovery.discoverGitHub).mockResolvedValueOnce([
      parseGitHubSkillUrl(`${REPOSITORY_URL}/tree/main/skills/gsap-core`).source,
      parseGitHubSkillUrl(`${REPOSITORY_URL}/tree/main/skills/gsap-timeline`).source,
    ]);
    vi.mocked(installer.install)
      .mockResolvedValueOnce(installed("gsap-core", "skills/gsap-core"))
      .mockResolvedValueOnce(installed("gsap-timeline", "skills/gsap-timeline"));

    const job = await service.ensureForTurn({ sourceUrls: [REPOSITORY_URL], mode: "ensure" }, scope, `安装 ${REPOSITORY_URL}`);

    expect(job.state).toBe("succeeded");
    expect(job.items).toHaveLength(2);
    expect(discovery.discoverGitHub).toHaveBeenCalledWith(expect.objectContaining({ requestedRef: "HEAD", subdirectory: "." }));
    expect((await agents.get(scope.agentId)).skills).toHaveLength(2);
  });

  it("ensure 复用同一来源且不调用安装器，然后原子绑定 Agent", async () => {
    const { service, scope, repository, installer, agents } = await setup(["install-a"]);
    const now = new Date().toISOString();
    await repository.putInstallation({
      schemaVersion: 1,
      skillInstallationId: "install-a",
      ownerId: scope.ownerId,
      skillName: "frontend-design",
      displayName: "frontend-design",
      state: "ready",
      source: parseGitHubSkillUrl(URL_A).source,
      contentHash: "abc",
      createdAt: now,
      updatedAt: now,
    });
    const job = await service.ensureForTurn({ sourceUrls: [URL_A], mode: "ensure" }, scope, `请安装 ${URL_A}`);
    expect(job.state).toBe("succeeded");
    expect(job.items[0]?.disposition).toBe("reused");
    expect(installer.install).not.toHaveBeenCalled();
    expect((await agents.get(scope.agentId)).skills).toEqual([{ skillInstallationId: "install-a", enabled: true }]);
  });

  it("ensure 工具成功后只返回安装事实，不生成另一份 Skill 调用清单", async () => {
    const { service, scope, repository } = await setup(["install-a"]);
    const now = new Date().toISOString();
    await repository.putInstallation({
      schemaVersion: 1,
      skillInstallationId: "install-a",
      ownerId: scope.ownerId,
      skillName: "frontend-design",
      displayName: "frontend-design",
      state: "ready",
      source: parseGitHubSkillUrl(URL_A).source,
      contentHash: "abc",
      createdAt: now,
      updatedAt: now,
    });
    const provider = new EnsureAgentSkillsToolProvider(service, scope, `请安装 ${URL_A}`);
    const prepared = provider.prepare({
      name: "ensure_agent_skills",
      arguments: { source_urls: [URL_A], mode: "ensure" },
    }, "ensure-success");

    const result = await new ToolRuntime(provider).executeBatch(
      [prepared],
      observer(),
      new ToolCallLedger(),
      new AbortController().signal,
    );
    const model = JSON.parse(result.outcomes[0]?.modelContent ?? "{}") as {
      result?: {
        installed_skill_names?: string[];
        capabilities_changed?: boolean;
        required_next_action?: unknown;
      };
      instruction?: string;
    };

    expect(model.result?.installed_skill_names).toEqual(["frontend-design"]);
    expect(model.result?.capabilities_changed).toBe(true);
    expect(model.result).not.toHaveProperty("required_next_action");
    expect(model.instruction).not.toContain("activate_skill");
  });

  it("可删除已经失去目录的旧 GitHub 安装记录", async () => {
    const { service, repository, installer } = await setup();
    const now = new Date().toISOString();
    await repository.putInstallation({
      schemaVersion: 1,
      skillInstallationId: "legacy-install",
      ownerId: "local-admin",
      skillName: "frontend-design",
      displayName: "frontend-design",
      state: "ready",
      source: parseGitHubSkillUrl(URL_A).source,
      createdAt: now,
      updatedAt: now,
    });

    expect(await service.get("legacy-install")).toMatchObject({ deletable: true });
    await expect(service.uninstall("legacy-install")).resolves.toEqual({ removedAgentBindings: [] });
    expect(installer.uninstall).toHaveBeenCalledWith("frontend-design");
    await expect(service.get("legacy-install")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("启动时清理目录已不存在的旧 GitHub 安装记录", async () => {
    const { service, repository } = await setup();
    const now = new Date().toISOString();
    await repository.putInstallation({
      schemaVersion: 1,
      skillInstallationId: "stale-install",
      ownerId: "local-admin",
      skillName: "missing",
      displayName: "missing",
      state: "ready",
      source: parseGitHubSkillUrl(URL_A).source,
      createdAt: now,
      updatedAt: now,
    });

    await service.importExisting();
    expect(await service.list()).toEqual([]);
    expect(await repository.getInstallation("stale-install")).toBeUndefined();
  });

  it("启动时把上一个 Remote 遗留的 Skill 任务收敛为 interrupted", async () => {
    const { service, repository } = await setup();
    const now = new Date().toISOString();
    await repository.putJob({
      schemaVersion: 1, jobId: "stale-job", ownerId: "local-admin", origin: { kind: "manual" },
      state: "running", items: [{ itemId: "item-1", source: parseGitHubSkillUrl(URL_A).source, state: "installing" }],
      bindToAgentOnComplete: false, createdAt: now, updatedAt: now,
    });

    await service.importExisting();
    expect(await repository.getJob("stale-job")).toMatchObject({
      state: "interrupted",
      items: [{ state: "failed", error: { code: "SKILL_JOB_INTERRUPTED", retryable: true } }],
    });
  });
});

async function setup(readyIds: string[] = [], resourceOrigins: string[] = []) {
  const dir = await mkdtemp(join(tmpdir(), "mk-skill-install-"));
  dirs.push(dir);
  const repository = new SkillInstallationRepository(join(dir, "installations.json"), join(dir, "jobs.json"));
  let service: SkillInstallationService | undefined;
  const agents = new AgentService(new AgentRepository(join(dir, "agents.json")), {
    builtinToolIds: () => [],
    readySkillInstallationIds: () => [...new Set([...readyIds, ...(service?.readyInstallationIdsSync() ?? [])])],
    mcpCapabilities: () => [],
  });
  const agent = await agents.create({
    name: "测试 Agent",
    systemPrompt: "测试",
    builtinTools: [], skillInstallationIds: [], mcps: [],
    historyPolicy: { mode: "none", maxTurns: 0 }, memoryPolicy: { mode: "off" },
  });
  const registry = new SkillRegistry([], new SkillLockStore(join(dir, "lock.json")));
  await registry.initialize();
  const discovery: SkillDiscoveryPort = {
    discoverGitHub: vi.fn(async (source) => [source]),
  };
  const installer: SkillInstallerPort = {
    install: vi.fn(),
    uninstall: vi.fn(),
  };
  service = new SkillInstallationService(
    repository,
    discovery,
    installer,
    registry,
    agents,
    new SkillSourceUrlPolicy(resourceOrigins),
  );
  const scope: TurnScope = {
    schemaVersion: 1,
    ownerId: "local-admin",
    sessionId: "session-a",
    turnId: "turn-a",
    purpose: "chat",
    modelStudentId: "fixture-student",
    agentId: agent.agentId,
  };
  return { service, scope, repository, discovery, installer, agents };
}

function installed(name: string, subdir: string) {
  return {
    name, description: `${name} test`, rootPath: `/tmp/${name}`, contentHash: `${name}-hash`,
    source: { kind: "git" as const, url: `${REPOSITORY_URL}.git`, commit: "a".repeat(40), subdir },
    scope: "user" as const, installedAt: Date.now(), trust: "approved" as const, manifest: { name, description: `${name} test` },
  };
}

function installedResource(name: string) {
  return {
    name, description: `${name} test`, rootPath: `/tmp/${name}`, contentHash: "resource-hash",
    source: { kind: "resource" as const, url: RESOURCE_URL, contentHash: "resource-hash" },
    scope: "user" as const, installedAt: Date.now(), trust: "approved" as const,
    manifest: { name, description: `${name} test` },
  };
}

function observer(): ToolObserver {
  return {
    toolStart: vi.fn(async () => undefined),
    toolFinish: vi.fn(async () => undefined),
    requestPermission: vi.fn(async () => true),
    askUser: vi.fn(async () => ""),
  };
}
