import { randomUUID } from "node:crypto";
import type {
  EnsureAgentSkillsInput,
  SkillInstallJob,
  SkillInstallJobItem,
  SkillInstallation,
  SkillSource,
  PublicErrorCode,
} from "@kindergarten/contracts";
import type { AgentService } from "../agent/agent-service.js";
import { ApiProblemError } from "../server/api-problem.js";
import type { TurnScope } from "../runtime/turn-scope.js";
import { explicitGitHubSkillUrls, parseGitHubSkillUrl, sameGitHubSource } from "./github-skill-source.js";
import type { SkillDiscoveryPort } from "./skill-discovery.js";
import type { SkillInstallationRepository } from "./skill-installation-repository.js";
import type { SkillRegistry } from "./skill-registry.js";
import type { SkillInstallRecord } from "./skill-types.js";

export class SkillInstallationService {
  private readonly readyIds = new Set<string>();
  constructor(
    private readonly repository: SkillInstallationRepository,
    private readonly discovery: SkillDiscoveryPort,
    private readonly installer: SkillInstallerPort,
    private readonly registry: SkillRegistry,
    private readonly agents: AgentService,
  ) {}

  async importExisting(ownerId = "local-admin"): Promise<void> {
    await this.repository.interruptActiveJobs();
    const registered = this.registry.all();
    const registeredNames = new Set(registered.map((skill) => skill.name));
    const persisted = await this.repository.listInstallations();

    // GitHub Skill 目录若已从磁盘移除，对应安装记录与 Agent 绑定也必须失效。
    for (const stale of persisted.filter((item) =>
      item.ownerId === ownerId &&
      item.state !== "uninstalled" &&
      item.source.kind === "github_tree" &&
      !registeredNames.has(item.skillName))) {
      await this.agents.removeSkillBindings(stale.skillInstallationId, ownerId);
      await this.repository.removeInstallation(stale.skillInstallationId);
      this.readyIds.delete(stale.skillInstallationId);
    }

    const active = (await this.repository.listInstallations())
      .filter((item) => item.ownerId === ownerId && item.state !== "uninstalled");
    for (const skill of registered) {
      const matches = active.filter((item) => item.skillName === skill.name);
      if (matches.length > 1) throw new Error(`Skill name 存在重复安装记录: ${skill.name}`);
      const existing = matches[0];
      if (existing) {
        this.readyIds.add(existing.skillInstallationId);
        continue;
      }
      const now = new Date().toISOString();
      const skillInstallationId = randomUUID();
      await this.repository.putInstallation({
        schemaVersion: 1,
        skillInstallationId,
        ownerId,
        skillName: skill.name,
        displayName: skill.name,
        state: "ready",
        source: toPublicSource(skill),
        contentHash: skill.contentHash,
        installedPathRef: `skill-root:${skillInstallationId}`,
        createdAt: now,
        updatedAt: now,
      });
      this.readyIds.add(skillInstallationId);
    }
  }

  async list(ownerId = "local-admin"): Promise<SkillInstallation[]> {
    return (await this.repository.listInstallations())
      .filter((item) => item.ownerId === ownerId && item.state !== "uninstalled")
      .map((item) => ({ ...item, deletable: this.isDeletable(item) }))
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async get(id: string, ownerId = "local-admin"): Promise<SkillInstallation> {
    const value = await this.repository.getInstallation(id);
    if (!value || value.ownerId !== ownerId || value.state === "uninstalled") {
      throw new ApiProblemError(404, "NOT_FOUND", "Skill Installation 不存在", false);
    }
    return { ...value, deletable: this.isDeletable(value) };
  }

  async readyInstallationIds(ownerId = "local-admin"): Promise<string[]> {
    const ids = (await this.list(ownerId)).filter((item) => item.state === "ready").map((item) => item.skillInstallationId);
    ids.forEach((id) => this.readyIds.add(id));
    return ids;
  }

  async uninstall(id: string, ownerId = "local-admin"): Promise<{ removedAgentBindings: string[] }> {
    const installation = await this.get(id, ownerId);
    const installed = this.registry.all().find((item) => item.name === installation.skillName);
    if (installed ? installed.scope !== "user" : installation.source.kind !== "github_tree") {
      throw new ApiProblemError(409, "CONFLICT", "系统内置或项目 Skill 不可删除", false);
    }

    const agents = await this.agents.removeSkillBindings(installation.skillInstallationId, ownerId);

    const name = installed?.name ?? installation.displayName;
    if (name) await this.installer.uninstall(name);
    await this.registry.refresh();
    await this.repository.removeInstallation(installation.skillInstallationId);
    this.readyIds.delete(installation.skillInstallationId);
    return { removedAgentBindings: agents.map((agent) => agent.agentId).toSorted() };
  }

  private isDeletable(installation: SkillInstallation): boolean {
    const installed = this.registry.all().find((item) => item.name === installation.skillName);
    return installed ? installed.scope === "user" : installation.source.kind === "github_tree";
  }

  readyInstallationIdsSync(): string[] {
    return [...this.readyIds].toSorted();
  }

  async runtimeSkillNames(installationIds: string[], ownerId: string): Promise<string[]> {
    const result: string[] = [];
    for (const id of installationIds) {
      const installation = await this.get(id, ownerId);
      if (installation.state !== "ready") {
        throw new ApiProblemError(409, "CAPABILITY_STALE", `Skill Installation 不可用: ${id}`, false);
      }
      result.push(installation.skillName);
    }
    return [...new Set(result)];
  }

  async createManualJob(
    sourceUrls: string[],
    bind: { bindToAgentOnComplete: boolean; agentId?: string },
    ownerId = "local-admin",
  ): Promise<SkillInstallJob> {
    sourceUrls.forEach(parseGitHubSkillUrl);
    const job = await this.createJob(sourceUrls, { kind: "manual" }, bind.bindToAgentOnComplete, ownerId);
    void this.run(job.jobId, "ensure", bind.agentId).catch(() => undefined);
    return job;
  }

  async ensureForTurn(
    raw: EnsureAgentSkillsInput,
    scope: TurnScope,
    currentUserMessage: string,
  ): Promise<SkillInstallJob> {
    const input = parseEnsureInput(raw);
    const explicit = new Set(explicitGitHubSkillUrls(currentUserMessage));
    const canonicalUrls = input.sourceUrls.map((url) => parseGitHubSkillUrl(url).sourceUrl);
    const unauthorized = canonicalUrls.find((url) => !explicit.has(url));
    if (unauthorized) {
      throw new ApiProblemError(400, "SKILL_SOURCE_NOT_USER_PROVIDED", `只能安装当前用户消息中明确给出的 Skill URL: ${unauthorized}`, false);
    }
    const job = await this.createJob(canonicalUrls, {
      kind: "turn",
      sessionId: scope.sessionId,
      turnId: scope.turnId,
      agentId: scope.agentId,
    }, true, scope.ownerId);
    return this.run(job.jobId, input.mode, scope.agentId);
  }

  async getJob(jobId: string, ownerId = "local-admin"): Promise<SkillInstallJob> {
    const job = await this.repository.getJob(jobId);
    if (!job || job.ownerId !== ownerId) throw new ApiProblemError(404, "NOT_FOUND", "Skill 安装任务不存在", false);
    return job;
  }

  async retryJob(jobId: string, ownerId = "local-admin"): Promise<SkillInstallJob> {
    const previous = await this.getJob(jobId, ownerId);
    if (previous.state !== "failed" && previous.state !== "interrupted") {
      throw new ApiProblemError(409, "CONFLICT", "只有失败或中断的 Skill 安装任务可以重试", false);
    }
    const urls = previous.items.map((item) => item.source.kind === "github_tree" ? sourceUrl(item.source) : undefined);
    if (urls.some((item) => !item)) throw new ApiProblemError(409, "CONFLICT", "该任务来源不支持重试", false);
    const job = await this.createJob(urls as string[], previous.origin, previous.bindToAgentOnComplete, ownerId);
    const agentId = previous.origin.kind === "turn" ? previous.origin.agentId : undefined;
    void this.run(job.jobId, "ensure", agentId).catch(() => undefined);
    return job;
  }

  private async createJob(
    sourceUrls: string[],
    origin: SkillInstallJob["origin"],
    bindToAgentOnComplete: boolean,
    ownerId: string,
  ): Promise<SkillInstallJob> {
    if (sourceUrls.length < 1 || sourceUrls.length > 10) {
      throw new ApiProblemError(400, "VALIDATION_FAILED", "一次只能提供 1-10 个 Skill 来源地址", false);
    }
    const sources: Array<Extract<SkillSource, { kind: "github_tree" }>> = [];
    for (const url of sourceUrls) {
      const parsed = parseGitHubSkillUrl(url);
      try {
        sources.push(...await this.discovery.discoverGitHub(parsed.source));
      } catch (error) {
        if (isGitHubFetchFailure(error)) throw githubConnectionProblem(parsed.repository);
        throw new ApiProblemError(400, "SKILL_VALIDATION_FAILED", publicMessage(error), false);
      }
    }
    const now = new Date().toISOString();
    const job: SkillInstallJob = {
      schemaVersion: 1,
      jobId: randomUUID(),
      ownerId,
      origin,
      state: "queued",
      items: sources.map((source) => ({ itemId: randomUUID(), source, state: "queued" })),
      bindToAgentOnComplete,
      createdAt: now,
      updatedAt: now,
    };
    await this.repository.putJob(job);
    return job;
  }

  private async run(jobId: string, mode: "ensure" | "update", agentId?: string): Promise<SkillInstallJob> {
    let job = await this.getJob(jobId);
    job = { ...job, state: "running", updatedAt: new Date().toISOString() };
    await this.repository.putJob(job);
    const completed: SkillInstallJobItem[] = [];
    try {
      for (const item of job.items) completed.push(await this.installItem(item, job.ownerId, mode));
      if (job.bindToAgentOnComplete) {
        if (!agentId) throw new Error("绑定 Skill 时缺少 agentId");
        await this.agents.mergeReadySkills(agentId, completed.flatMap((item) => item.skillInstallationId ? [item.skillInstallationId] : []), job.ownerId);
      }
      job = {
        ...job,
        state: "succeeded",
        items: completed,
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
      await this.repository.putJob(job);
      return job;
    } catch (error) {
      job = {
        ...job,
        state: "failed",
        items: [...completed, ...job.items.slice(completed.length).map((item, index) => index === 0 ? {
          ...item,
          state: "failed" as const,
          error: {
            code: errorCode(error),
            message: publicMessage(error),
            retryable: error instanceof ApiProblemError ? error.retryable : false,
          },
        } : item)],
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
      await this.repository.putJob(job);
      throw error;
    }
  }

  private async installItem(
    item: SkillInstallJobItem,
    ownerId: string,
    mode: "ensure" | "update",
  ): Promise<SkillInstallJobItem> {
    if (item.source.kind !== "github_tree") throw new Error("只支持 GitHub Skill 来源");
    const source = item.source;
    const existing = (await this.list(ownerId)).find((candidate) => {
      if (candidate.source.kind !== "github_tree") return false;
      return sameGitHubSource(candidate.source, source);
    });
    if (existing && mode === "ensure") {
      return { ...item, state: "ready", skillInstallationId: existing.skillInstallationId, disposition: "reused" };
    }
    const parsed = parseGitHubSkillUrl(sourceUrl(item.source));
    let installed: SkillInstallRecord;
    try {
      installed = await this.installer.install({
        approved: true,
        source: {
          kind: "git",
          url: parsed.cloneUrl,
          ref: item.source.resolvedCommit ?? item.source.requestedRef,
          subdir: item.source.subdirectory,
        },
      }, { replaceExisting: Boolean(existing && mode === "update") });
    } catch (error) {
      if (/Skill 已安装/.test(publicMessage(error))) {
        throw new ApiProblemError(409, "SKILL_SOURCE_NAME_CONFLICT", "同名 Skill 已由另一个来源安装", false);
      }
      if (isGitHubFetchFailure(error)) {
        throw githubConnectionProblem(item.source.repository);
      }
      throw error;
    }
    await this.registry.refresh();
    const id = existing?.skillInstallationId ?? randomUUID();
    const now = new Date().toISOString();
    await this.repository.putInstallation({
      schemaVersion: 1,
      skillInstallationId: id,
      ownerId,
      skillName: installed.name,
      displayName: installed.name,
      state: "ready",
      source: {
        ...item.source,
        ...(installed.source.kind === "git" ? { resolvedCommit: installed.source.commit } : {}),
      },
      contentHash: installed.contentHash,
      installedPathRef: `skill-root:${id}`,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    this.readyIds.add(id);
    return { ...item, state: "ready", skillInstallationId: id, disposition: existing ? "updated" : "installed" };
  }
}

export interface SkillInstallerPort {
  install(
    request: import("./skill-types.js").SkillInstallRequest,
    options?: { replaceExisting?: boolean },
  ): Promise<SkillInstallRecord>;
  uninstall(name: string): Promise<void>;
}

function parseEnsureInput(value: EnsureAgentSkillsInput): EnsureAgentSkillsInput {
  if (!value || !Array.isArray(value.sourceUrls) || !value.sourceUrls.every((item) => typeof item === "string") ||
    (value.mode !== "ensure" && value.mode !== "update")) {
    throw new ApiProblemError(400, "VALIDATION_FAILED", "ensure_agent_skills 参数无效", false);
  }
  return { sourceUrls: [...new Set(value.sourceUrls)], mode: value.mode };
}

function sourceUrl(source: Extract<SkillSource, { kind: "github_tree" }>): string {
  if (source.requestedRef === "HEAD" && source.subdirectory === ".") return source.repository;
  return `${source.repository}/tree/${encodeURIComponent(source.requestedRef)}/${source.subdirectory.split("/").map(encodeURIComponent).join("/")}`;
}

function toPublicSource(skill: SkillInstallRecord): SkillSource {
  if (skill.source.kind === "git") {
    return {
      kind: "github_tree",
      repository: skill.source.url.replace(/\.git$/, ""),
      requestedRef: skill.source.commit,
      resolvedCommit: skill.source.commit,
      subdirectory: skill.source.subdir ?? ".",
    };
  }
  return { kind: "approved_local", sourceId: skill.name };
}

function errorCode(error: unknown): PublicErrorCode {
  return error instanceof ApiProblemError ? error.code : "SKILL_VALIDATION_FAILED";
}

function publicMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isGitHubFetchFailure(error: unknown): boolean {
  const message = publicMessage(error);
  return /could not resolve host|failed to connect|connection timed out|operation timed out|curl \d+|early eof|expected flush after ref listing|connection reset/i.test(message);
}

function githubConnectionProblem(repository: string): ApiProblemError {
  return new ApiProblemError(
    502,
    "SKILL_JOB_INTERRUPTED",
    `GitHub 仓库地址格式已验证（.git 后缀合法）；连接 ${repository}.git 下载失败或超时，操作已终止，请稍后重新提交安装`,
    true,
  );
}
