import { randomUUID } from "node:crypto";
import {
  parseModelStudentInstallInput,
  parseModelStudentCandidateInput,
  PRODUCT_CONFIG,
  type ModelProviderPresetView,
  type ModelStudentSummary,
  type ModelStudentTestRecord,
  type ProviderCapabilitySnapshot,
  type ResolvedModelStudentCandidate,
} from "@kindergarten/contracts";
import type { WritableSecretStore } from "../mcp/secret-store.js";
import type { SecretRef } from "../mcp/mcp-types.js";
import { ApiProblemError } from "../server/api-problem.js";
import {
  ModelAdmissionConflictError,
  type ModelAdmissionRepository,
  type ManagedModelStudentRecord,
  type ProviderConnectionRecord,
} from "./model-admission-repository.js";
import { ModelStudentCatalog } from "./model-student-catalog.js";
import {
  RemoteModelUrlPolicy,
  RemoteModelUrlPolicyError,
} from "./remote-model-url-policy.js";
import { ModelAdmissionAdapterRegistry } from "./model-admission-adapter-registry.js";
import { ModelProviderPresetRegistry } from "./model-provider-preset-registry.js";

const DEFAULT_TEST_TTL_MS = 15 * 60_000;

/** 描述「ModelAdmissionServiceOptions」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ModelAdmissionServiceOptions {
  testTtlMs?: number;
  now?: () => Date;
  modelInUse?: (modelStudentId: string) => boolean | Promise<boolean>;
}

/** 控制面唯一持有瞬时 apiKey；Repository、Catalog 和 Provider 都只接收安全引用。 */
export class ModelAdmissionService {
  private readonly candidates = new Map<string, ResolvedModelStudentCandidate>();
  private readonly candidateExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly installationClaims = new Set<string>();
  /** 只统计正在执行端点主动探针的请求，所有退出路径在 finally 中归还。 */
  private activeTests = 0;
  private readonly testTtlMs: number;
  private readonly now: () => Date;
  private readonly modelInUse: (modelStudentId: string) => boolean | Promise<boolean>;

  /** 初始化「ModelAdmissionService」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(
    private readonly repository: ModelAdmissionRepository,
    private readonly secrets: WritableSecretStore,
    private readonly adapters: ModelAdmissionAdapterRegistry,
    private readonly presets: ModelProviderPresetRegistry,
    private readonly catalog: ModelStudentCatalog,
    private readonly urlPolicy = new RemoteModelUrlPolicy(),
    options: ModelAdmissionServiceOptions = {},
  ) {
    this.testTtlMs = options.testTtlMs ?? DEFAULT_TEST_TTL_MS;
    this.now = options.now ?? (/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
() => new Date());
    this.modelInUse = options.modelInUse ?? (/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
() => false);
  }

  /** 执行「restoreInstalled」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async restoreInstalled(): Promise<ModelStudentSummary[]> {
    await this.repository.persistMigrations();
    const restored: ModelStudentSummary[] = [];
    const rows = (await this.repository.installed()).toSorted(/** 执行「rows」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(left, right) =>
      left.student.createdAt.localeCompare(right.student.createdAt) ||
      left.student.modelStudentId.localeCompare(right.student.modelStudentId));
    const seenTests = new Set<string>();
    const seenModels = new Set<string>();

    for (const row of rows) {
      let { student } = row;
      const { connection } = row;
      const reboundSnapshot = this.adapters.bindSnapshot(student.snapshot, {
        presetId: connection.presetId,
        protocol: connection.protocol,
        baseUrl: connection.baseUrl,
        model: student.model,
      });
      if (JSON.stringify(reboundSnapshot) !== JSON.stringify(student.snapshot)) {
        student = await this.repository.setSnapshot(student.modelStudentId, student.ownerId, reboundSnapshot);
      }
      if (this.catalog.get(student.modelStudentId)) continue;
      if (student.lifecycle === "archived") {
        restored.push(this.catalog.registerUnavailable(
          studentMetadata(student, connection),
          "模型已停用；历史 Session 可查看，但不能继续对话",
          {
            ownerId: student.ownerId,
            deletable: true,
            lastCheckedAt: student.snapshot.testedAt,
            supports: supportsFrom(student.snapshot),
          },
        ));
        continue;
      }
      if (
        student.lifecycle === "capacity_blocked" ||
        this.catalog.runtimeProviderCount >= PRODUCT_CONFIG.capacity.maxModelStudents
      ) {
        if (student.lifecycle !== "capacity_blocked") {
          student = await this.repository.setLifecycle(
            student.modelStudentId,
            student.ownerId,
            "capacity_blocked",
          );
        }
        restored.push(this.catalog.registerCapacityBlocked(
          studentMetadata(student, connection),
          {
            ownerId: student.ownerId,
            deletable: true,
            lastCheckedAt: student.snapshot.testedAt,
            supports: supportsFrom(student.snapshot),
          },
        ));
        continue;
      }
      let reconciliationMessage: string | undefined;
      const lifecycle = student.lifecycle ?? "active";
      if (lifecycle === "rollback_pending" || lifecycle === "deleting") {
        const removeCredential = (await this.repository.listStudents(student.ownerId))
          .filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.connectionId === connection.connectionId).length <= 1;
        const completed = await this.resumeRemoval(
          student,
          connection,
          removeCredential,
        );
        if (completed) continue;
        reconciliationMessage = lifecycle === "rollback_pending"
          ? "上次入园回滚尚未完成，当前模型不会参与运行"
          : "上次删除尚未完成，当前模型不会参与运行";
      } else if (lifecycle === "installing") {
        try {
          if (connection.credentialRef) await this.secrets.read(connection.credentialRef);
          student = await this.repository.setLifecycle(student.modelStudentId, student.ownerId, "active");
        } catch {
          student = await this.repository.setLifecycle(student.modelStudentId, student.ownerId, "rollback_pending");
          const removeCredential = (await this.repository.listStudents(student.ownerId))
            .filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.connectionId === connection.connectionId).length <= 1;
          const completed = await this.resumeRemoval(student, connection, removeCredential);
          if (completed) continue;
          reconciliationMessage = "上次入园未完成且回滚待收口，当前模型不会参与运行";
        }
      }

      if ((student.lifecycle ?? "active") === "active" && !reconciliationMessage) {
        const modelKey = `${student.ownerId}\u0000${connection.protocol}\u0000${connection.baseUrl}\u0000${student.model}`;
        const duplicateTest = student.installationTestId !== undefined && seenTests.has(student.installationTestId);
        const duplicateModel = seenModels.has(modelKey);
        if (duplicateTest || duplicateModel) {
          reconciliationMessage = "检测到重复入园记录，已隔离且不会参与运行";
        } else {
          if (student.installationTestId) seenTests.add(student.installationTestId);
          seenModels.add(modelKey);
        }
      }

      const provider = this.adapters.createProvider(student, connection);
      let initialStatus: ModelStudentSummary["status"] = reconciliationMessage ? "unavailable" : "ready";
      let statusMessage = reconciliationMessage;
      if (!statusMessage) {
        try {
          if (connection.credentialRef) await this.secrets.read(connection.credentialRef);
          if (connection.protocol === "ollama_native") await provider.verify?.();
        } catch {
          initialStatus = "unavailable";
          statusMessage = connection.protocol === "ollama_native"
            ? "本机 Ollama 或目标模型当前不可用"
            : "模型凭据不可用，请重新入园";
        }
      }
      restored.push(this.catalog.register(provider, {
        ownerId: student.ownerId,
        initialStatus,
        ...(statusMessage ? { statusMessage } : {}),
        lastCheckedAt: student.snapshot.testedAt,
        deletable: true,
        supports: supportsFrom(student.snapshot),
      }));
    }
    return restored;
  }

  /** 在进程并发与 Candidate 容量内执行入园体检；超限立即 503，不创建等待任务。 */
async test(raw: unknown, ownerId = "local-admin"): Promise<ModelStudentTestRecord> {
    let candidate: ResolvedModelStudentCandidate;
    try {
      candidate = this.presets.resolve(parseModelStudentCandidateInput(raw));
    } catch (error) {
      throw new ApiProblemError(400, "VALIDATION_FAILED", publicMessage(error), false);
    }
    if (this.activeTests >= PRODUCT_CONFIG.capacity.maxConcurrentModelAdmissionTests) {
      throw new ApiProblemError(503, "REMOTE_BUSY", "正在执行的模型连接体检已达到容量上限", true);
    }
    if (this.candidates.size + this.activeTests >= PRODUCT_CONFIG.capacity.maxRetainedModelCandidates) {
      throw new ApiProblemError(503, "REMOTE_BUSY", "等待安装的模型 Candidate 已达到容量上限，请先安装或等待过期", true);
    }
    this.activeTests += 1;
    try {
      return await this.testCandidate(candidate, ownerId);
    } finally {
      this.activeTests -= 1;
    }
  }

  /** 执行一次已取得容量名额的端点探针，并把持久化记录收敛到 succeeded 或 failed。 */
  private async testCandidate(
    candidate: ResolvedModelStudentCandidate,
    ownerId: string,
  ): Promise<ModelStudentTestRecord> {
    try {
      if (candidate.protocol !== "ollama_native") await this.urlPolicy.assert(candidate.baseUrl);
    } catch (error) {
      throw urlProblem(error);
    }

    const started = this.now();
    const initial: ModelStudentTestRecord = {
      schemaVersion: 1,
      testId: randomUUID(),
      ownerId,
      candidate: publicCandidate(candidate),
      state: "testing",
      createdAt: started.toISOString(),
      expiresAt: new Date(started.getTime() + this.testTtlMs).toISOString(),
    };
    await this.repository.putTest(initial);

    try {
      const snapshot = await this.adapters.probe(candidate);
      if (!snapshot.streaming || !snapshot.text) {
        throw new Error("该端点未通过流式文本能力体检");
      }
      const completed = this.now();
      const succeeded: ModelStudentTestRecord = {
        ...initial,
        state: "succeeded",
        snapshot,
        expiresAt: new Date(completed.getTime() + this.testTtlMs).toISOString(),
      };
      await this.repository.putTest(succeeded);
      this.retainCandidate(succeeded.testId, candidate, succeeded.expiresAt);
      return succeeded;
    } catch (error) {
      this.forgetCandidate(initial.testId);
      const completed = this.now();
      const failed: ModelStudentTestRecord = {
        ...initial,
        state: "failed",
        error: {
          code: error instanceof RemoteModelUrlPolicyError && error.reason === "not_allowed"
            ? "MODEL_URL_NOT_ALLOWED"
            : "MODEL_CONNECTION_FAILED",
          message: redactPublicMessage(error, candidate.apiKey ?? ""),
          retryable: !(error instanceof RemoteModelUrlPolicyError && error.reason === "not_allowed"),
        },
        expiresAt: new Date(completed.getTime() + this.testTtlMs).toISOString(),
      };
      await this.repository.putTest(failed);
      return failed;
    }
  }

  /** 执行「providerPresets」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
providerPresets(): ModelProviderPresetView[] {
    return this.presets.views();
  }

  /** 读取「getTest」所需数据，并遵守作用域、分页与容量边界。 */
async getTest(testId: string, ownerId = "local-admin"): Promise<ModelStudentTestRecord> {
    const test = await this.repository.getTest(testId);
    if (!test || test.ownerId !== ownerId) {
      throw new ApiProblemError(404, "NOT_FOUND", "模型连接测试不存在", false);
    }
    if (test.state === "succeeded" && Date.parse(test.expiresAt) <= this.now().getTime()) {
      this.forgetCandidate(testId);
      const expired: ModelStudentTestRecord = { ...test, state: "expired" };
      await this.repository.putTest(expired);
      return expired;
    }
    return test;
  }

  /** 执行「install」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async install(raw: unknown, ownerId = "local-admin"): Promise<ModelStudentSummary> {
    let input: ReturnType<typeof parseModelStudentInstallInput>;
    try {
      input = parseModelStudentInstallInput(raw);
    } catch (error) {
      throw new ApiProblemError(400, "VALIDATION_FAILED", publicMessage(error), false);
    }
    // claim 必须在第一个 await 之前取得；否则两个并发调用都能越过检查，后发请求可能反而抢先安装。
    if (this.installationClaims.has(input.testId)) {
      throw new ApiProblemError(409, "CONFLICT", "该模型测试正在执行入园，不能重复提交", true);
    }
    this.installationClaims.add(input.testId);
    try {
      if ((await this.repository.listStudents(ownerId)).length >= PRODUCT_CONFIG.capacity.maxModelStudents) {
        throw new ApiProblemError(
          409,
          "CONFLICT",
          `ModelStudent 已达到 ${PRODUCT_CONFIG.capacity.maxModelStudents} 条运行目录容量上限`,
          false,
        );
      }
      return await this.installClaimed(input, ownerId);
    } finally {
      this.installationClaims.delete(input.testId);
    }
  }

  /** 执行「installClaimed」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
private async installClaimed(
    input: ReturnType<typeof parseModelStudentInstallInput>,
    ownerId: string,
  ): Promise<ModelStudentSummary> {
    const test = await this.getTest(input.testId, ownerId);
    const candidate = this.candidates.get(input.testId);
    if (test.state !== "succeeded" || !test.snapshot || !candidate || Date.parse(test.expiresAt) <= this.now().getTime()) {
      throw new ApiProblemError(409, "MODEL_PROBE_EXPIRED", "模型连接测试未成功、已过期或服务已重启，请重新测试", false);
    }
    const defaultReasoningProfile = input.defaultReasoningProfile ?? test.snapshot.reasoning.capability.defaultProfile;
    if (input.defaultReasoningProfile) {
      if (!test.snapshot.reasoning.capability.supportedProfiles.includes(input.defaultReasoningProfile)) {
        throw new ApiProblemError(
          400,
          "VALIDATION_FAILED",
          `当前 ModelStudent 体检不支持默认推理档位: ${input.defaultReasoningProfile}`,
          false,
        );
      }
    }

    const displayName = input.displayName ?? candidate.displayName;
    const installed = await this.repository.listStudents(ownerId);
    if (installed.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.displayName === displayName)) {
      throw new ApiProblemError(409, "CONFLICT", "已经存在同名 ModelStudent", false);
    }
    const connections = await this.repository.listConnections(ownerId);
    if (installed.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(student) =>
      student.model === candidate.model && connections.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(connection) =>
        connection.connectionId === student.connectionId &&
        connection.baseUrl === candidate.baseUrl &&
        connection.protocol === candidate.protocol,
      ))) {
      throw new ApiProblemError(409, "CONFLICT", "该 Provider 模型已经入园", false);
    }

    const now = this.now().toISOString();
    const connectionId = id("connection");
    const modelStudentId = id("student");
    const credentialRef: SecretRef | undefined = candidate.apiKey === undefined ? undefined : {
      provider: "managed",
      key: `models-kindergarten/provider-connections/${connectionId}`,
    };
    const connection: ProviderConnectionRecord = {
      schemaVersion: 1,
      recordKind: "provider_connection",
      connectionId,
      ownerId,
      presetId: candidate.presetId,
      protocol: candidate.protocol,
      baseUrl: candidate.baseUrl,
      ...(credentialRef ? { credentialRef } : {}),
      ...(candidate.apiKey === undefined ? {} : { credentialHint: credentialHint(candidate.apiKey) }),
      createdAt: now,
      updatedAt: now,
    };
    const student: ManagedModelStudentRecord = {
      schemaVersion: 1,
      recordKind: "model_student",
      modelStudentId,
      ownerId,
      connectionId,
      displayName,
      model: candidate.model,
      sizeClass: candidate.protocol === "ollama_native" ? "small" : "large",
      ...(input.contextWindowTokens === undefined
        ? {}
        : { contextWindowTokens: input.contextWindowTokens }),
      lifecycle: "installing",
      installationTestId: test.testId,
      generationDefaults: { reasoningProfile: defaultReasoningProfile },
      snapshot: structuredClone(test.snapshot),
      createdAt: now,
      updatedAt: now,
    };
    const provider = this.adapters.createProvider(student, connection);

    let repositoryPrepared = false;
    try {
      await this.repository.install(connection, student);
      repositoryPrepared = true;
      if (credentialRef && candidate.apiKey !== undefined) {
        await this.secrets.write(credentialRef, candidate.apiKey);
      }
      await this.repository.setLifecycle(modelStudentId, ownerId, "active");
      const summary = this.catalog.register(provider, {
        ownerId,
        initialStatus: "ready",
        lastCheckedAt: test.snapshot.testedAt,
        deletable: true,
        supports: supportsFrom(test.snapshot),
      });
      this.forgetCandidate(test.testId);
      return summary;
    } catch (error) {
      if (repositoryPrepared) {
        await this.repository.setLifecycle(modelStudentId, ownerId, "rollback_pending").catch(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => undefined);
        let credentialRemoved = credentialRef === undefined;
        try {
          if (credentialRef) await this.secrets.delete(credentialRef);
          credentialRemoved = true;
        } catch {
          // rollback_pending 会在下次启动继续清理，且不会注册为 ready。
        }
        if (credentialRemoved) {
          await this.repository.removeStudent(modelStudentId, ownerId).catch(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => undefined);
        }
      }
      if (error instanceof ApiProblemError) throw error;
      if (error instanceof ModelAdmissionConflictError) {
        throw new ApiProblemError(409, "CONFLICT", error.message, false);
      }
      throw new ApiProblemError(503, "MODEL_CONNECTION_FAILED", "模型凭据或安装记录保存失败", true);
    }
  }

  /** 读取「list」所需数据，并遵守作用域、分页与容量边界。 */
async list(ownerId = "local-admin"): Promise<ModelStudentSummary[]> {
    const ownedIds = new Set((await this.repository.listStudents(ownerId)).map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.modelStudentId));
    return this.catalog.all().filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => !item.deletable || ownedIds.has(item.modelStudentId));
  }

  /** 读取「get」所需数据，并遵守作用域、分页与容量边界。 */
async get(modelStudentId: string, ownerId = "local-admin"): Promise<ModelStudentSummary> {
    const summary = this.catalog.get(modelStudentId, ownerId);
    if (!summary) throw new ApiProblemError(404, "NOT_FOUND", "ModelStudent 不存在", false);
    if (summary.deletable) {
      const record = await this.repository.getStudent(modelStudentId);
      if (!record || record.ownerId !== ownerId) throw new ApiProblemError(404, "NOT_FOUND", "ModelStudent 不存在", false);
    }
    return summary;
  }

  /** 释放或删除「remove」对应资源，重复调用仍保持安全。 */
async remove(modelStudentId: string, ownerId = "local-admin"): Promise<{ modelStudentId: string }> {
    const summary = await this.get(modelStudentId, ownerId);
    if (!summary.deletable) {
      throw new ApiProblemError(409, "CONFLICT", "系统内置 ModelStudent 不可删除", false);
    }
    const stored = await this.repository.getStudent(modelStudentId);
    if (!stored || stored.ownerId !== ownerId) throw new ApiProblemError(404, "NOT_FOUND", "ModelStudent 不存在", false);
    const connection = await this.repository.getConnection(stored.connectionId);
    if (!connection) throw new ApiProblemError(500, "INTERNAL_ERROR", "ModelStudent 缺少 ProviderConnection", true);
    const connectionShared = (await this.repository.listStudents(ownerId)).some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) =>
      item.modelStudentId !== modelStudentId && item.connectionId === stored.connectionId);
    if (await this.modelInUse(modelStudentId)) {
      await this.repository.setLifecycle(modelStudentId, ownerId, "archived");
      try {
        if (!connectionShared && connection.credentialRef) {
          await this.secrets.delete(connection.credentialRef);
        }
      } catch {
        await this.repository.setLifecycle(modelStudentId, ownerId, "active");
        throw new ApiProblemError(503, "MODEL_CONNECTION_FAILED", "模型凭据删除失败，已恢复为可用状态", true);
      }
      this.catalog.deactivate(modelStudentId, "模型已停用；历史 Session 可查看，但不能继续对话");
      return { modelStudentId };
    }
    await this.repository.setLifecycle(modelStudentId, ownerId, "deleting");
    let credentialRemoved = connectionShared;
    try {
      if (!connectionShared) {
        if (connection.credentialRef) await this.secrets.delete(connection.credentialRef);
        credentialRemoved = true;
      }
      const removed = await this.repository.removeStudent(modelStudentId, ownerId);
      if (!removed) throw new Error("删除事务中的 ModelStudent 消失");
    } catch {
      if (!credentialRemoved) {
        const restored = await this.repository.setLifecycle(modelStudentId, ownerId, "active")
          .then(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => true, /** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => false);
        if (!restored) {
          this.catalog.setStatus(modelStudentId, "unavailable", "删除事务状态待恢复，当前模型不会参与运行");
        }
      } else {
        this.catalog.setStatus(modelStudentId, "unavailable", "凭据已删除，等待完成模型记录清理");
      }
      throw new ApiProblemError(503, "MODEL_CONNECTION_FAILED", "模型删除事务未完成，服务会保留或继续收口该记录", true);
    }
    this.catalog.unregister(modelStudentId);
    return { modelStudentId };
  }

  /** 执行「resumeRemoval」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
private async resumeRemoval(
    student: ManagedModelStudentRecord,
    connection: ProviderConnectionRecord,
    removeCredential: boolean,
  ): Promise<boolean> {
    try {
      if (removeCredential && connection.credentialRef) await this.secrets.delete(connection.credentialRef);
      await this.repository.removeStudent(student.modelStudentId, student.ownerId);
      return true;
    } catch {
      return false;
    }
  }

  /** 执行「retainCandidate」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
  private retainCandidate(testId: string, candidate: ResolvedModelStudentCandidate, expiresAt: string): void {
    this.forgetCandidate(testId);
    if (this.candidates.size >= PRODUCT_CONFIG.capacity.maxRetainedModelCandidates) {
      throw new Error(`等待安装的模型 Candidate 已达到 ${PRODUCT_CONFIG.capacity.maxRetainedModelCandidates} 条容量上限`);
    }
    this.candidates.set(testId, candidate);
    const delay = Math.max(0, Date.parse(expiresAt) - this.now().getTime());
    const timer = setTimeout(/** 执行受生命周期约束的定时任务，调用方负责在结束时取消句柄。 */
() => this.forgetCandidate(testId), delay);
    timer.unref?.();
    this.candidateExpiryTimers.set(testId, timer);
  }

  /** 执行「forgetCandidate」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
private forgetCandidate(testId: string): void {
    this.candidates.delete(testId);
    const timer = this.candidateExpiryTimers.get(testId);
    if (timer) clearTimeout(timer);
    this.candidateExpiryTimers.delete(testId);
  }
}

/** 判断「supportsFrom」对应条件，只返回判定结果且不修改输入状态。 */
function supportsFrom(snapshot: ProviderCapabilitySnapshot) {
  return {
    streaming: snapshot.streaming,
    toolCalls: snapshot.toolCalls && snapshot.toolContinuation,
    thought: snapshot.thought,
    usage: snapshot.usage,
    reasoning: snapshot.reasoning.capability,
  };
}

/** 从持久化安全字段构造被容量阻断模型的元数据，不实例化含连接能力的 Provider。 */
function studentMetadata(
  student: ManagedModelStudentRecord,
  connection: ProviderConnectionRecord,
): import("./model-provider.js").ModelStudent {
  return {
    id: student.modelStudentId,
    name: student.displayName,
    sizeClass: student.sizeClass,
    ...(student.contextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: student.contextWindowTokens }),
    provider: {
      kind: connection.presetId === "ollama"
        ? "ollama"
        : connection.presetId === "siliconflow"
          ? "siliconflow"
          : "openai-compatible",
      model: student.model,
      baseUrl: connection.baseUrl,
    },
    generationDefaults: structuredClone(student.generationDefaults),
  };
}

/** 执行「publicCandidate」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function publicCandidate(candidate: ResolvedModelStudentCandidate) {
  return {
    presetId: candidate.presetId,
    displayName: candidate.displayName,
    baseUrl: candidate.baseUrl,
    model: candidate.model,
    protocol: candidate.protocol,
  };
}

/** 执行「credentialHint」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function credentialHint(value: string): string {
  return value.length <= 4 ? "••••" : `••••${value.slice(-4)}`;
}

/** 执行「id」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

/** 执行「publicMessage」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function publicMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 执行「redactPublicMessage」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function redactPublicMessage(error: unknown, secret: string): string {
  let message = publicMessage(error);
  if (secret) message = message.split(secret).join("[REDACTED]");
  message = message.replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]");
  return message.slice(0, 500) || "模型接口体检失败";
}

/** 执行「urlProblem」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function urlProblem(error: unknown): ApiProblemError {
  if (error instanceof RemoteModelUrlPolicyError) {
    return error.reason === "not_allowed"
      ? new ApiProblemError(400, "MODEL_URL_NOT_ALLOWED", error.message, false)
      : new ApiProblemError(400, "MODEL_CONNECTION_FAILED", error.message, true);
  }
  return new ApiProblemError(400, "MODEL_URL_NOT_ALLOWED", "模型 Base URL 不允许访问", false);
}
