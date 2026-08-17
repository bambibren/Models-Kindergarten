import { randomUUID } from "node:crypto";
import {
  parseModelStudentInstallInput,
  parseModelStudentCandidateInput,
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
  private readonly testTtlMs: number;
  private readonly now: () => Date;
  private readonly modelInUse: (modelStudentId: string) => boolean | Promise<boolean>;

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
    this.now = options.now ?? (() => new Date());
    this.modelInUse = options.modelInUse ?? (() => false);
  }

  async restoreInstalled(): Promise<ModelStudentSummary[]> {
    await this.repository.persistMigrations();
    const restored: ModelStudentSummary[] = [];
    const rows = (await this.repository.installed()).toSorted((left, right) =>
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
      let reconciliationMessage: string | undefined;
      const lifecycle = student.lifecycle ?? "active";
      if (lifecycle === "rollback_pending" || lifecycle === "deleting") {
        const removeCredential = (await this.repository.listStudents(student.ownerId))
          .filter((item) => item.connectionId === connection.connectionId).length <= 1;
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
          await this.secrets.read(connection.credentialRef);
          student = await this.repository.setLifecycle(student.modelStudentId, student.ownerId, "active");
        } catch {
          student = await this.repository.setLifecycle(student.modelStudentId, student.ownerId, "rollback_pending");
          const removeCredential = (await this.repository.listStudents(student.ownerId))
            .filter((item) => item.connectionId === connection.connectionId).length <= 1;
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
          await this.secrets.read(connection.credentialRef);
        } catch {
          initialStatus = "unavailable";
          statusMessage = "模型凭据不可用，请重新入园";
        }
      }
      restored.push(this.catalog.register(provider, {
        initialStatus,
        ...(statusMessage ? { statusMessage } : {}),
        lastCheckedAt: student.snapshot.testedAt,
        deletable: true,
        supports: supportsFrom(student.snapshot),
      }));
    }
    return restored;
  }

  async test(raw: unknown, ownerId = "local-admin"): Promise<ModelStudentTestRecord> {
    let candidate: ResolvedModelStudentCandidate;
    try {
      candidate = this.presets.resolve(parseModelStudentCandidateInput(raw));
    } catch (error) {
      throw new ApiProblemError(400, "VALIDATION_FAILED", publicMessage(error), false);
    }
    try {
      await this.urlPolicy.assert(candidate.baseUrl);
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
          message: redactPublicMessage(error, candidate.apiKey),
          retryable: !(error instanceof RemoteModelUrlPolicyError && error.reason === "not_allowed"),
        },
        expiresAt: new Date(completed.getTime() + this.testTtlMs).toISOString(),
      };
      await this.repository.putTest(failed);
      return failed;
    }
  }

  providerPresets(): ModelProviderPresetView[] {
    return this.presets.views();
  }

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

  async install(raw: unknown, ownerId = "local-admin"): Promise<ModelStudentSummary> {
    let input: ReturnType<typeof parseModelStudentInstallInput>;
    try {
      input = parseModelStudentInstallInput(raw);
    } catch (error) {
      throw new ApiProblemError(400, "VALIDATION_FAILED", publicMessage(error), false);
    }
    if (this.installationClaims.has(input.testId)) {
      throw new ApiProblemError(409, "CONFLICT", "该模型测试正在执行入园，不能重复提交", true);
    }
    this.installationClaims.add(input.testId);
    try {
      return await this.installClaimed(input, ownerId);
    } finally {
      this.installationClaims.delete(input.testId);
    }
  }

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
    if (installed.some((item) => item.displayName === displayName)) {
      throw new ApiProblemError(409, "CONFLICT", "已经存在同名 ModelStudent", false);
    }
    const connections = await this.repository.listConnections(ownerId);
    if (installed.some((student) =>
      student.model === candidate.model && connections.some((connection) =>
        connection.connectionId === student.connectionId &&
        connection.baseUrl === candidate.baseUrl &&
        connection.protocol === candidate.protocol,
      ))) {
      throw new ApiProblemError(409, "CONFLICT", "该 Provider 模型已经入园", false);
    }

    const now = this.now().toISOString();
    const connectionId = id("connection");
    const modelStudentId = id("student");
    const credentialRef: SecretRef = {
      provider: "keychain",
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
      credentialRef,
      credentialHint: credentialHint(candidate.apiKey),
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
      sizeClass: "large",
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
      await this.secrets.write(credentialRef, candidate.apiKey);
      await this.repository.setLifecycle(modelStudentId, ownerId, "active");
      const summary = this.catalog.register(provider, {
        initialStatus: "ready",
        lastCheckedAt: test.snapshot.testedAt,
        deletable: true,
        supports: supportsFrom(test.snapshot),
      });
      this.forgetCandidate(test.testId);
      return summary;
    } catch (error) {
      if (repositoryPrepared) {
        await this.repository.setLifecycle(modelStudentId, ownerId, "rollback_pending").catch(() => undefined);
        let credentialRemoved = false;
        try {
          await this.secrets.delete(credentialRef);
          credentialRemoved = true;
        } catch {
          // rollback_pending 会在下次启动继续清理，且不会注册为 ready。
        }
        if (credentialRemoved) {
          await this.repository.removeStudent(modelStudentId, ownerId).catch(() => undefined);
        }
      }
      if (error instanceof ApiProblemError) throw error;
      if (error instanceof ModelAdmissionConflictError) {
        throw new ApiProblemError(409, "CONFLICT", error.message, false);
      }
      throw new ApiProblemError(503, "MODEL_CONNECTION_FAILED", "模型凭据或安装记录保存失败", true);
    }
  }

  async list(ownerId = "local-admin"): Promise<ModelStudentSummary[]> {
    const ownedIds = new Set((await this.repository.listStudents(ownerId)).map((item) => item.modelStudentId));
    return this.catalog.all().filter((item) => !item.deletable || ownedIds.has(item.modelStudentId));
  }

  async get(modelStudentId: string, ownerId = "local-admin"): Promise<ModelStudentSummary> {
    const summary = this.catalog.get(modelStudentId);
    if (!summary) throw new ApiProblemError(404, "NOT_FOUND", "ModelStudent 不存在", false);
    if (summary.deletable) {
      const record = await this.repository.getStudent(modelStudentId);
      if (!record || record.ownerId !== ownerId) throw new ApiProblemError(404, "NOT_FOUND", "ModelStudent 不存在", false);
    }
    return summary;
  }

  async remove(modelStudentId: string, ownerId = "local-admin"): Promise<{ modelStudentId: string }> {
    const summary = await this.get(modelStudentId, ownerId);
    if (!summary.deletable) {
      throw new ApiProblemError(409, "CONFLICT", "系统内置 ModelStudent 不可删除", false);
    }
    if (await this.modelInUse(modelStudentId)) {
      throw new ApiProblemError(409, "MODEL_IN_USE", "仍有 Session 绑定该 ModelStudent，不能删除", false);
    }
    const stored = await this.repository.getStudent(modelStudentId);
    if (!stored || stored.ownerId !== ownerId) throw new ApiProblemError(404, "NOT_FOUND", "ModelStudent 不存在", false);
    const connection = await this.repository.getConnection(stored.connectionId);
    if (!connection) throw new ApiProblemError(500, "INTERNAL_ERROR", "ModelStudent 缺少 ProviderConnection", true);
    const connectionShared = (await this.repository.listStudents(ownerId)).some((item) =>
      item.modelStudentId !== modelStudentId && item.connectionId === stored.connectionId);
    await this.repository.setLifecycle(modelStudentId, ownerId, "deleting");
    let credentialRemoved = connectionShared;
    try {
      if (!connectionShared) {
        await this.secrets.delete(connection.credentialRef);
        credentialRemoved = true;
      }
      const removed = await this.repository.removeStudent(modelStudentId, ownerId);
      if (!removed) throw new Error("删除事务中的 ModelStudent 消失");
    } catch {
      if (!credentialRemoved) {
        const restored = await this.repository.setLifecycle(modelStudentId, ownerId, "active")
          .then(() => true, () => false);
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

  private async resumeRemoval(
    student: ManagedModelStudentRecord,
    connection: ProviderConnectionRecord,
    removeCredential: boolean,
  ): Promise<boolean> {
    try {
      if (removeCredential) await this.secrets.delete(connection.credentialRef);
      await this.repository.removeStudent(student.modelStudentId, student.ownerId);
      return true;
    } catch {
      return false;
    }
  }

  private retainCandidate(testId: string, candidate: ResolvedModelStudentCandidate, expiresAt: string): void {
    this.forgetCandidate(testId);
    this.candidates.set(testId, candidate);
    const delay = Math.max(0, Date.parse(expiresAt) - this.now().getTime());
    const timer = setTimeout(() => this.forgetCandidate(testId), delay);
    timer.unref?.();
    this.candidateExpiryTimers.set(testId, timer);
  }

  private forgetCandidate(testId: string): void {
    this.candidates.delete(testId);
    const timer = this.candidateExpiryTimers.get(testId);
    if (timer) clearTimeout(timer);
    this.candidateExpiryTimers.delete(testId);
  }
}

function supportsFrom(snapshot: ProviderCapabilitySnapshot) {
  return {
    streaming: snapshot.streaming,
    toolCalls: snapshot.toolCalls && snapshot.toolContinuation,
    thought: snapshot.thought,
    usage: snapshot.usage,
    reasoning: snapshot.reasoning.capability,
  };
}

function publicCandidate(candidate: ResolvedModelStudentCandidate) {
  return {
    presetId: candidate.presetId,
    displayName: candidate.displayName,
    baseUrl: candidate.baseUrl,
    model: candidate.model,
    protocol: candidate.protocol,
  };
}

function credentialHint(value: string): string {
  return value.length <= 4 ? "••••" : `••••${value.slice(-4)}`;
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function publicMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactPublicMessage(error: unknown, secret: string): string {
  let message = publicMessage(error);
  if (secret) message = message.split(secret).join("[REDACTED]");
  message = message.replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]");
  return message.slice(0, 500) || "模型接口体检失败";
}

function urlProblem(error: unknown): ApiProblemError {
  if (error instanceof RemoteModelUrlPolicyError) {
    return error.reason === "not_allowed"
      ? new ApiProblemError(400, "MODEL_URL_NOT_ALLOWED", error.message, false)
      : new ApiProblemError(400, "MODEL_CONNECTION_FAILED", error.message, true);
  }
  return new ApiProblemError(400, "MODEL_URL_NOT_ALLOWED", "模型 Base URL 不允许访问", false);
}
