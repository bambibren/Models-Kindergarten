import { randomUUID } from "node:crypto";
import {
  PRODUCT_CONFIG,
  type PublicErrorCode,
  type EnsureAgentSkillsInput,
  type SkillInstallJob,
  type SkillInstallJobItem,
  type SkillInstallation,
  type SkillSource,
} from "@kindergarten/contracts";
import type { AgentService } from "../agent/agent-service.js";
import { ApiProblemError } from "../server/api-problem.js";
import type { TurnScope } from "../runtime/turn-scope.js";
import { parseGitHubSkillUrl } from "./github-skill-source.js";
import type { SkillDiscoveryPort } from "./skill-discovery.js";
import type { SkillInstallationRepository } from "./skill-installation-repository.js";
import type { SkillRegistry } from "./skill-registry.js";
import { builtinSkillId } from "./skill-registry.js";
import type { SkillInstallRecord } from "./skill-types.js";
import { SkillSourceUrlPolicy, type ExplicitSkillSourceUrl } from "./skill-source-url.js";

/** 描述「SkillInstallationService」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export class SkillInstallationService {
  private readonly readyIds = new Set<string>();
  /** 初始化「SkillInstallationService」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(
    private readonly repository: SkillInstallationRepository,
    private readonly discovery: SkillDiscoveryPort,
    private readonly installer: SkillInstallerPort,
    private readonly registry: SkillRegistry,
    private readonly agents: AgentService,
    private readonly sourcePolicy = new SkillSourceUrlPolicy(),
  ) {}

  /** 执行「importExisting」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async importExisting(ownerId = "local-admin"): Promise<void> {
    await this.repository.interruptActiveJobs();
    const registered = this.registry.all();
    const registeredNames = new Set(registered.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(skill) => skill.name));
    const persisted = await this.repository.listInstallations();

    const capacitySaturated = registered.length >= PRODUCT_CONFIG.capacity.maxInstalledSkills;
    // 达到目录容量时，不把未加载的旧记录误判为删除；它们保留事实但退出 Runtime 能力。
    for (const stale of persisted.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) =>
      item.state !== "uninstalled" &&
      remoteSource(item.source) &&
      !registeredNames.has(item.skillName))) {
      await this.agents.removeSkillBindings(stale.skillInstallationId, stale.ownerId);
      if (capacitySaturated) {
        await this.repository.putInstallation({
          ...stale,
          state: "capacity_blocked",
          error: {
            code: "CAPABILITY_STALE",
            message: `Skill Registry 已达到 ${PRODUCT_CONFIG.capacity.maxInstalledSkills} 条容量上限`,
            retryable: false,
          },
          updatedAt: new Date().toISOString(),
        });
        this.readyIds.delete(stale.skillInstallationId);
        continue;
      }
      await this.repository.removeInstallation(stale.skillInstallationId);
      this.readyIds.delete(stale.skillInstallationId);
    }

    const active = (await this.repository.listInstallations())
      .filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.state !== "uninstalled");
    for (const skill of registered) {
      const matches = active.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.skillName === skill.name);
      if (matches.length > 0) {
        for (const existing of matches) {
          if (existing.state !== "ready") {
            const { error: _error, ...restored } = existing;
            await this.repository.putInstallation({
              ...restored,
              state: "ready",
              updatedAt: new Date().toISOString(),
            });
          }
          this.readyIds.add(existing.skillInstallationId);
        }
        continue;
      }
      // Builtin Skill 由 Registry 以固定 ID 全局提供；用户目录没有 owner 元数据时也不能转赠。
      if (skill.scope === "builtin" || skill.scope === "user") continue;
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

  /** 把历史伪装成 Installation 的 Builtin Skill 转换为全局固定引用。 */
  async migrateBuiltinInstallations(): Promise<number> {
    const builtinNames = new Set(this.registry.all()
      .filter((skill) => skill.scope === "builtin")
      .map((skill) => skill.name));
    const legacy = (await this.repository.listInstallations()).filter((installation) =>
      installation.state !== "uninstalled" &&
      installation.source.kind === "approved_local" &&
      builtinNames.has(installation.skillName));
    if (legacy.length === 0) {
      await this.agents.migrateBuiltinSkillBindings(new Map());
      return 0;
    }
    const replacements = new Map(legacy.map((installation) => [
      installation.skillInstallationId,
      builtinSkillId(installation.skillName),
    ]));
    await this.agents.migrateBuiltinSkillBindings(replacements);
    for (const installation of legacy) {
      await this.repository.removeInstallation(installation.skillInstallationId);
      this.readyIds.delete(installation.skillInstallationId);
    }
    return legacy.length;
  }

  /** 读取「list」所需数据，并遵守作用域、分页与容量边界。 */
async list(ownerId = "local-admin"): Promise<SkillInstallation[]> {
    return (await this.repository.listInstallations())
      .filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.ownerId === ownerId && item.state !== "uninstalled")
      .map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => ({ ...item, deletable: this.isDeletable(item) }))
      .toSorted(/** 读取「list」所需数据，并遵守作用域、分页与容量边界。 */
(left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  /** 读取「get」所需数据，并遵守作用域、分页与容量边界。 */
async get(id: string, ownerId = "local-admin"): Promise<SkillInstallation> {
    const value = await this.repository.getInstallation(id);
    if (!value || value.ownerId !== ownerId || value.state === "uninstalled") {
      throw new ApiProblemError(404, "NOT_FOUND", "Skill Installation 不存在", false);
    }
    return { ...value, deletable: this.isDeletable(value) };
  }

  /** 读取「readyInstallationIds」所需数据，并遵守作用域、分页与容量边界。 */
  async readyInstallationIds(ownerId = "local-admin"): Promise<string[]> {
    const ids = (await this.list(ownerId)).filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.state === "ready").map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.skillInstallationId);
    ids.forEach(/** 读取「readyInstallationIds」所需数据，并遵守作用域、分页与容量边界。 */
(id) => this.readyIds.add(id));
    return ids;
  }

  /** 返回账号仍拥有的安装记录；暂不可用记录仍用于判断引用没有被删除。 */
  async installationIds(ownerId = "local-admin"): Promise<string[]> {
    return (await this.list(ownerId)).map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.skillInstallationId);
  }

  /** 执行「uninstall」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
  async uninstall(id: string, ownerId = "local-admin"): Promise<{ removedAgentBindings: string[] }> {
    const installation = await this.get(id, ownerId);
    const installed = this.registry.all().find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.name === installation.skillName);
    if (installed ? installed.scope !== "user" : !remoteSource(installation.source)) {
      throw new ApiProblemError(409, "CONFLICT", "系统内置或项目 Skill 不可删除", false);
    }

    const agents = await this.agents.removeSkillBindings(installation.skillInstallationId, ownerId);
    await this.repository.removeInstallation(installation.skillInstallationId);
    this.readyIds.delete(installation.skillInstallationId);
    const stillReferenced = (await this.repository.listInstallations()).some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.skillName === installation.skillName && item.state !== "uninstalled");
    if (!stillReferenced) {
      const name = installed?.name ?? installation.displayName;
      if (name) await this.installer.uninstall(name);
      await this.registry.refresh();
    }
    return { removedAgentBindings: agents.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(agent) => agent.agentId).toSorted() };
  }

  /** 判断「isDeletable」对应条件，只返回判定结果且不修改输入状态。 */
private isDeletable(installation: SkillInstallation): boolean {
    const installed = this.registry.all().find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.name === installation.skillName);
    return installed ? installed.scope === "user" : remoteSource(installation.source);
  }

  /** 执行「explicitSourceUrlCandidates」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
explicitSourceUrlCandidates(message: string): ExplicitSkillSourceUrl[] {
    return this.sourcePolicy.explicitCandidates(message);
  }

  /** 读取「readyInstallationIdsSync」所需数据，并遵守作用域、分页与容量边界。 */
readyInstallationIdsSync(): string[] {
    return [...this.readyIds].toSorted();
  }

  /** 执行「runtimeSkillNames」主流程，传播取消与失败并在结束时清理临时资源。 */
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

  /** 根据已校验输入构建「createManualJob」结果，不额外持有调用方的大对象。 */
async createManualJob(
    sourceUrls: string[],
    bind: { bindToAgentOnComplete: boolean; agentId?: string },
    ownerId = "local-admin",
  ): Promise<SkillInstallJob> {
    sourceUrls.forEach(/** 根据已校验输入构建「createManualJob」结果，不额外持有调用方的大对象。 */
(url) => this.sourcePolicy.parse(url));
    const job = await this.createJob(sourceUrls, { kind: "manual" }, bind.bindToAgentOnComplete, ownerId);
    void this.run(job.jobId, "ensure", bind.agentId).catch(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => undefined);
    return job;
  }

  /** 校验并取得「ensureForTurn」所需对象；缺失或归属不符时立即抛出明确错误。 */
async ensureForTurn(
    raw: EnsureAgentSkillsInput,
    scope: TurnScope,
    currentUserMessage: string,
  ): Promise<SkillInstallJob> {
    const input = parseEnsureInput(raw);
    const explicit = new Set(this.sourcePolicy.explicitUrls(currentUserMessage));
    const canonicalUrls = input.sourceUrls.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(url) => this.sourcePolicy.parse(url).sourceUrl);
    const unauthorized = canonicalUrls.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(url) => !explicit.has(url));
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

  /** 读取「getJob」所需数据，并遵守作用域、分页与容量边界。 */
async getJob(jobId: string, ownerId = "local-admin"): Promise<SkillInstallJob> {
    const job = await this.repository.getJob(jobId);
    if (!job || job.ownerId !== ownerId) throw new ApiProblemError(404, "NOT_FOUND", "Skill 安装任务不存在", false);
    return job;
  }

  /** 执行「retryJob」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async retryJob(jobId: string, ownerId = "local-admin"): Promise<SkillInstallJob> {
    const previous = await this.getJob(jobId, ownerId);
    if (previous.state !== "failed" && previous.state !== "interrupted") {
      throw new ApiProblemError(409, "CONFLICT", "只有失败或中断的 Skill 安装任务可以重试", false);
    }
    const urls = previous.items.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.source.kind === "approved_local" ? undefined : this.sourcePolicy.sourceUrl(item.source));
    if (urls.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => !item)) throw new ApiProblemError(409, "CONFLICT", "该任务来源不支持重试", false);
    const job = await this.createJob(urls as string[], previous.origin, previous.bindToAgentOnComplete, ownerId);
    const agentId = previous.origin.kind === "turn" ? previous.origin.agentId : undefined;
    void this.run(job.jobId, "ensure", agentId).catch(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => undefined);
    return job;
  }

  /** 根据已校验输入构建「createJob」结果，不额外持有调用方的大对象。 */
private async createJob(
    sourceUrls: string[],
    origin: SkillInstallJob["origin"],
    bindToAgentOnComplete: boolean,
    ownerId: string,
  ): Promise<SkillInstallJob> {
    if (sourceUrls.length < 1) {
      throw new ApiProblemError(400, "VALIDATION_FAILED", "至少提供 1 个 Skill URL", false);
    }
    if (sourceUrls.length > PRODUCT_CONFIG.skill.maxSourceUrlsPerJob) {
      throw new ApiProblemError(
        400,
        "SKILL_SOURCE_URL_LIMIT_EXCEEDED",
        `单次 Skill 安装最多接收 ${PRODUCT_CONFIG.skill.maxSourceUrlsPerJob} 个 URL；本次提供了 ${sourceUrls.length} 个`,
        false,
      );
    }
    const sources: Array<Exclude<SkillSource, { kind: "approved_local" }>> = [];
    for (const url of sourceUrls) {
      const parsed = this.sourcePolicy.parse(url);
      if (parsed.kind === "resource") {
        sources.push(parsed.source);
        continue;
      }
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
      items: sources.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(source) => ({ itemId: randomUUID(), source, state: "queued" })),
      bindToAgentOnComplete,
      createdAt: now,
      updatedAt: now,
    };
    await this.repository.putJob(job);
    return job;
  }

  /** 执行「run」主流程，传播取消与失败并在结束时清理临时资源。 */
private async run(jobId: string, mode: "ensure" | "update", agentId?: string): Promise<SkillInstallJob> {
    let job = await this.repository.getJob(jobId);
    if (!job) throw new ApiProblemError(404, "NOT_FOUND", "Skill 安装任务不存在", false);
    job = { ...job, state: "running", updatedAt: new Date().toISOString() };
    await this.repository.putJob(job);
    const completed: SkillInstallJobItem[] = [];
    try {
      for (const item of job.items) completed.push(await this.installItem(item, job.ownerId, mode));
      if (job.bindToAgentOnComplete) {
        if (!agentId) throw new Error("绑定 Skill 时缺少 agentId");
        await this.agents.mergeReadySkills(agentId, completed.flatMap(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(item) => item.skillInstallationId ? [item.skillInstallationId] : []), job.ownerId);
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
        items: [...completed, ...job.items.slice(completed.length).map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item, index) => index === 0 ? {
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

  /** 执行「installItem」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
  private async installItem(
    item: SkillInstallJobItem,
    ownerId: string,
    mode: "ensure" | "update",
  ): Promise<SkillInstallJobItem> {
    if (item.source.kind === "approved_local") throw new Error("安装任务不接受本地派生来源");
    const source = item.source;
    const allInstallations = await this.repository.listInstallations();
    const existing = (await this.list(ownerId)).find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(candidate) => {
      return this.sourcePolicy.sameSource(candidate.source, source);
    });
    if (existing && mode === "ensure") {
      return this.reuseInstallation(item, ownerId, existing);
    }
    const sourceName = resourceSkillName(source);
    const sameName = mode === "ensure" && sourceName
      ? allInstallations.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(candidate) => candidate.state === "ready" && candidate.skillName === sourceName && candidate.ownerId === ownerId) ??
        allInstallations.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(candidate) => candidate.state === "ready" && candidate.skillName === sourceName)
      : undefined;
    if (sameName) {
      return this.reuseInstallation(item, ownerId, sameName);
    }
    const shared = allInstallations.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(candidate) => candidate.ownerId !== ownerId && candidate.state === "ready" && this.sourcePolicy.sameSource(candidate.source, source));
    if (!existing && shared) {
      return this.reuseInstallation(item, ownerId, shared);
    }
    if (existing && mode === "update" && allInstallations.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(candidate) => candidate.ownerId !== ownerId && candidate.state === "ready" && candidate.skillName === existing.skillName)) {
      throw new ApiProblemError(409, "SKILL_SOURCE_NAME_CONFLICT", "同名 Skill 正被其他账号使用，不能单独更新共享内容", false);
    }
    if (!existing) {
      const installedCount = (await this.list(ownerId)).filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.state !== "uninstalled").length;
      if (installedCount >= PRODUCT_CONFIG.capacity.maxInstalledSkills) {
        throw new ApiProblemError(
          409,
          "CONFLICT",
          `Skill Installation 已达到 ${PRODUCT_CONFIG.capacity.maxInstalledSkills} 条容量上限`,
          false,
        );
      }
    }
    let installed: SkillInstallRecord;
    try {
      if (source.kind === "github_tree") {
        const parsed = parseGitHubSkillUrl(this.sourcePolicy.sourceUrl(source));
        installed = await this.installer.install({
          approved: true,
          source: {
            kind: "git",
            url: parsed.cloneUrl,
            ref: source.resolvedCommit ?? source.requestedRef,
            subdir: source.subdirectory,
          },
        }, { replaceExisting: Boolean(existing && mode === "update") });
      } else {
        installed = await this.installer.install({
          approved: true,
          source: { kind: "resource", url: source.url },
        }, { replaceExisting: Boolean(existing && mode === "update") });
      }
    } catch (error) {
      const installedName = alreadyInstalledSkillName(error);
      if (installedName && mode === "ensure") {
        const reusable = allInstallations.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(candidate) => candidate.state === "ready" && candidate.skillName === installedName && candidate.ownerId === ownerId) ??
          allInstallations.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(candidate) => candidate.state === "ready" && candidate.skillName === installedName);
        if (reusable) return this.reuseInstallation(item, ownerId, reusable);
      }
      if (installedName) {
        throw new ApiProblemError(409, "SKILL_SOURCE_NAME_CONFLICT", "同名 Skill 已由另一个来源安装", false);
      }
      if (isGitHubFetchFailure(error)) {
        if (source.kind === "github_tree") throw githubConnectionProblem(source.repository);
      }
      if (isResourceFetchFailure(error)) throw resourceConnectionProblem(source.kind === "resource_bundle" ? source.url : "");
      throw error;
    }
    await this.registry.refresh();
    const id = existing?.skillInstallationId ?? randomUUID();
    const now = new Date().toISOString();
    const persistedSource: Exclude<SkillSource, { kind: "approved_local" }> = source.kind === "github_tree"
      ? {
          ...source,
          ...(installed.source.kind === "git" ? { resolvedCommit: installed.source.commit } : {}),
        }
      : {
          ...source,
          resolvedContentHash: installed.contentHash,
        };
    await this.repository.putInstallation({
      schemaVersion: 1,
      skillInstallationId: id,
      ownerId,
      skillName: installed.name,
      displayName: installed.name,
      state: "ready",
      source: persistedSource,
      contentHash: installed.contentHash,
      installedPathRef: `skill-root:${id}`,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    this.readyIds.add(id);
    return { ...item, source: persistedSource, state: "ready", skillInstallationId: id, disposition: existing ? "updated" : "installed" };
  }

  /** 复用同名或同源的 ready Skill；跨账号时只创建独立归属记录，不复制物理内容。 */
  private async reuseInstallation(
    item: SkillInstallJobItem,
    ownerId: string,
    installation: SkillInstallation,
  ): Promise<SkillInstallJobItem> {
    if (installation.ownerId === ownerId) {
      this.readyIds.add(installation.skillInstallationId);
      return {
        ...item,
        source: installation.source,
        state: "ready",
        skillInstallationId: installation.skillInstallationId,
        disposition: "reused",
      };
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.repository.putInstallation({
      ...installation,
      skillInstallationId: id,
      ownerId,
      installedPathRef: `skill-root:${id}`,
      createdAt: now,
      updatedAt: now,
    });
    this.readyIds.add(id);
    return { ...item, source: installation.source, state: "ready", skillInstallationId: id, disposition: "reused" };
  }
}

/** 描述「SkillInstallerPort」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface SkillInstallerPort {
  install(
    request: import("./skill-types.js").SkillInstallRequest,
    options?: { replaceExisting?: boolean },
  ): Promise<SkillInstallRecord>;
  uninstall(name: string): Promise<void>;
}

/** 受管资源 URL 的路径就是公开 Skill 名称，可在下载前用于同名复用。 */
function resourceSkillName(source: Exclude<SkillSource, { kind: "approved_local" }>): string | undefined {
  if (source.kind !== "resource_bundle") return undefined;
  const match = new URL(source.url).pathname.match(/^\/skills\/([a-z0-9-]+)\/?$/);
  return match?.[1];
}

/** 安装器完成来源校验后会在冲突消息中返回真实 manifest name。 */
function alreadyInstalledSkillName(error: unknown): string | undefined {
  return publicMessage(error).match(/^Skill 已安装:\s*(.+)$/)?.[1]?.trim() || undefined;
}

/** 校验并规范化「parseEnsureInput」输入，非法数据直接返回明确错误。 */
function parseEnsureInput(value: EnsureAgentSkillsInput): EnsureAgentSkillsInput {
  if (!value || !Array.isArray(value.sourceUrls) || !value.sourceUrls.every(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => typeof item === "string") ||
    (value.mode !== "ensure" && value.mode !== "update")) {
    throw new ApiProblemError(400, "VALIDATION_FAILED", "ensure_agent_skills 参数无效", false);
  }
  return { sourceUrls: [...new Set(value.sourceUrls)], mode: value.mode };
}

/** 根据已校验输入构建「toPublicSource」结果，不额外持有调用方的大对象。 */
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
  if (skill.source.kind === "resource") {
    return { kind: "resource_bundle", url: skill.source.url, resolvedContentHash: skill.source.contentHash };
  }
  return { kind: "approved_local", sourceId: skill.name };
}

/** 执行「errorCode」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function errorCode(error: unknown): PublicErrorCode {
  return error instanceof ApiProblemError ? error.code : "SKILL_VALIDATION_FAILED";
}

/** 执行「publicMessage」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function publicMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 判断「isGitHubFetchFailure」对应条件，只返回判定结果且不修改输入状态。 */
function isGitHubFetchFailure(error: unknown): boolean {
  const message = publicMessage(error);
  return /could not resolve host|failed to connect|connection timed out|operation timed out|curl \d+|early eof|expected flush after ref listing|connection reset/i.test(message);
}

/** 判断「isResourceFetchFailure」对应条件，只返回判定结果且不修改输入状态。 */
function isResourceFetchFailure(error: unknown): boolean {
  return /SKILL_RESOURCE_DOWNLOAD_FAILED/.test(publicMessage(error));
}

/** 执行「remoteSource」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function remoteSource(source: SkillSource): source is Exclude<SkillSource, { kind: "approved_local" }> {
  return source.kind === "github_tree" || source.kind === "resource_bundle";
}

/** 执行「githubConnectionProblem」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function githubConnectionProblem(repository: string): ApiProblemError {
  return new ApiProblemError(
    502,
    "SKILL_JOB_INTERRUPTED",
    `GitHub 仓库地址格式已验证（.git 后缀合法）；连接 ${repository}.git 下载失败或超时，操作已终止，请稍后重新提交安装`,
    true,
  );
}

/** 执行「resourceConnectionProblem」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function resourceConnectionProblem(url: string): ApiProblemError {
  return new ApiProblemError(
    502,
    "SKILL_JOB_INTERRUPTED",
    `连接 Skill 静态资源 ${url} 下载失败或超时，操作已终止，请确认资源服务正在运行后重试`,
    true,
  );
}
