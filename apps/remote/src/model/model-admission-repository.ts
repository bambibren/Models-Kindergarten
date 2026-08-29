import {
  isConcreteReasoningProfile,
  readProviderCapabilitySnapshot,
  type ConcreteReasoningProfile,
  type ProviderCapabilitySnapshot,
  type ProviderProtocol,
  type ReadyModelProviderPresetId,
  type ModelStudentTestRecord,
  type ProviderConnectionView,
} from "@kindergarten/contracts";
import type { SecretRef } from "../mcp/mcp-types.js";
import { AtomicJsonStore } from "../storage/atomic-json-store.js";

/** 描述「ProviderConnectionRecord」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ProviderConnectionRecord {
  schemaVersion: 1;
  recordKind: "provider_connection";
  connectionId: string;
  ownerId: string;
  presetId: ReadyModelProviderPresetId;
  protocol: Exclude<ProviderProtocol, "anthropic_messages">;
  baseUrl: string;
  credentialRef?: SecretRef;
  credentialHint?: string;
  createdAt: string;
  updatedAt: string;
}

/** 描述「ManagedModelStudentRecord」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ManagedModelStudentRecord {
  schemaVersion: 1;
  recordKind: "model_student";
  modelStudentId: string;
  ownerId: string;
  connectionId: string;
  displayName: string;
  model: string;
  sizeClass: "small" | "large";
  contextWindowTokens?: number;
  /** 旧记录缺省视为 active；新事务必须显式写入。 */
  lifecycle?: "installing" | "active" | "archived" | "capacity_blocked" | "rollback_pending" | "deleting";
  installationTestId?: string;
  generationDefaults: {
    reasoningProfile: ConcreteReasoningProfile;
  };
  snapshot: ProviderCapabilitySnapshot;
  createdAt: string;
  updatedAt: string;
}

type AdmissionCatalogRecord = ProviderConnectionRecord | ManagedModelStudentRecord;

/** 描述「ModelAdmissionConflictError」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export class ModelAdmissionConflictError extends Error {
  /** 初始化「ModelAdmissionConflictError」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(readonly reason: "duplicate_id" | "duplicate_test" | "duplicate_model", message: string) {
    super(message);
  }
}

/** 测试记录与安装聚合分开存；安装时 Connection + ModelStudent 在一次原子提交中落盘。 */
export class ModelAdmissionRepository {
  private readonly tests: AtomicJsonStore<ModelStudentTestRecord>;
  private readonly catalog: AtomicJsonStore<AdmissionCatalogRecord>;

  /** 初始化「ModelAdmissionRepository」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(testsFile: string, catalogFile: string) {
    this.tests = new AtomicJsonStore({ file: testsFile, schemaVersion: 1, validate: isTestRecord });
    this.catalog = new AtomicJsonStore({ file: catalogFile, schemaVersion: 1, validate: isCatalogRecord });
  }

  /** 更新「putTest」对应状态，并保持写入顺序、原子性与容量约束。 */
async putTest(value: ModelStudentTestRecord): Promise<void> {
    const now = Date.now();
    await this.tests.update(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(records) => {
      const active = records.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.testId !== value.testId && !isExpired(item.expiresAt, now));
      // expired 是对调用方的一次性状态，不再重新写回已过期的临时测试记录。
      return isExpired(value.expiresAt, now) ? active : [...active, structuredClone(value)];
    });
  }

  /** 启动时一次性固化旧受管模型缺失的模型侧默认配置。 */
  async persistMigrations(): Promise<void> {
    await this.catalog.update(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(records) => records.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => {
      if (item.recordKind === "provider_connection" && item.credentialRef?.provider === "keychain") {
        return {
          ...item,
          credentialRef: { provider: "managed" as const, key: item.credentialRef.key },
          updatedAt: new Date().toISOString(),
        };
      }
      if (item.recordKind !== "model_student") return item;
      const legacy = item as ManagedModelStudentRecord & {
        generationDefaults?: ManagedModelStudentRecord["generationDefaults"];
      };
      if (legacy.generationDefaults) return item;
      const snapshot = readProviderCapabilitySnapshot(item.snapshot);
      return {
        ...item,
        generationDefaults: { reasoningProfile: snapshot.reasoning.capability.defaultProfile },
      };
    }));
  }

  /** 读取「getTest」所需数据，并遵守作用域、分页与容量边界。 */
async getTest(testId: string): Promise<ModelStudentTestRecord | undefined> {
    const now = Date.now();
    return this.tests.update(/** 读取「getTest」所需数据，并遵守作用域、分页与容量边界。 */
(records) => {
      const item = records.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(candidate) => candidate.testId === testId);
      const active = records.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(candidate) => !isExpired(candidate.expiresAt, now));
      return {
        records: active,
        // 首次命中过期记录时仍把事实返回给 Service；清理只影响后续查询。
        result: item ? normalizeTestRecord(item) : undefined,
      };
    });
  }

  /** 执行「install」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async install(connection: ProviderConnectionRecord, student: ManagedModelStudentRecord): Promise<void> {
    if (connection.connectionId !== student.connectionId || connection.ownerId !== student.ownerId) {
      throw new Error("ProviderConnection 与 ModelStudent 归属不一致");
    }
    await this.catalog.update(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(records) => {
      if (records.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.recordKind === "provider_connection" && item.connectionId === connection.connectionId)) {
        throw new ModelAdmissionConflictError("duplicate_id", `ProviderConnection 已存在: ${connection.connectionId}`);
      }
      if (records.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.recordKind === "model_student" && item.modelStudentId === student.modelStudentId)) {
        throw new ModelAdmissionConflictError("duplicate_id", `ModelStudent 已存在: ${student.modelStudentId}`);
      }
      if (student.installationTestId && records.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) =>
        item.recordKind === "model_student" && item.installationTestId === student.installationTestId,
      )) {
        throw new ModelAdmissionConflictError("duplicate_test", "同一模型测试已经完成过入园");
      }
      const connections = new Map(records
        .filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item): item is ProviderConnectionRecord => item.recordKind === "provider_connection")
        .map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => [item.connectionId, item]));
      if (records.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => {
        if (item.recordKind !== "model_student" || item.ownerId !== student.ownerId || item.model !== student.model) return false;
        const existing = connections.get(item.connectionId);
        return existing?.baseUrl === connection.baseUrl && existing.protocol === connection.protocol;
      })) {
        throw new ModelAdmissionConflictError("duplicate_model", "该 Provider 模型已经入园或正在处理");
      }
      return [...records, structuredClone(connection), structuredClone(student)];
    });
  }

  /** 更新「setLifecycle」对应状态，并保持写入顺序、原子性与容量约束。 */
async setLifecycle(
    modelStudentId: string,
    ownerId: string,
    lifecycle: NonNullable<ManagedModelStudentRecord["lifecycle"]>,
  ): Promise<ManagedModelStudentRecord> {
    const result = await this.catalog.update(/** 执行「result」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(records) => {
      const index = records.findIndex(/** 执行「index」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(item) => item.recordKind === "model_student" && item.modelStudentId === modelStudentId && item.ownerId === ownerId);
      if (index < 0) throw new Error(`ModelStudent 不存在: ${modelStudentId}`);
      const current = records[index];
      if (!current || current.recordKind !== "model_student") throw new Error(`ModelStudent 不存在: ${modelStudentId}`);
      const next: ManagedModelStudentRecord = {
        ...current,
        lifecycle,
        updatedAt: new Date().toISOString(),
      };
      records[index] = next;
      return { records, result: next };
    });
    if (!result) throw new Error(`ModelStudent 不存在: ${modelStudentId}`);
    return result;
  }

  /** 更新「setSnapshot」对应状态，并保持写入顺序、原子性与容量约束。 */
async setSnapshot(
    modelStudentId: string,
    ownerId: string,
    snapshot: ProviderCapabilitySnapshot,
  ): Promise<ManagedModelStudentRecord> {
    const normalized = readProviderCapabilitySnapshot(snapshot);
    const result = await this.catalog.update(/** 执行「result」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(records) => {
      const index = records.findIndex(/** 执行「index」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(item) => item.recordKind === "model_student" && item.modelStudentId === modelStudentId && item.ownerId === ownerId);
      if (index < 0) throw new Error(`ModelStudent 不存在: ${modelStudentId}`);
      const current = records[index];
      if (!current || current.recordKind !== "model_student") throw new Error(`ModelStudent 不存在: ${modelStudentId}`);
      const next: ManagedModelStudentRecord = {
        ...current,
        snapshot: normalized,
        updatedAt: new Date().toISOString(),
      };
      records[index] = next;
      return { records, result: next };
    });
    if (!result) throw new Error(`ModelStudent 不存在: ${modelStudentId}`);
    return result;
  }

  /** 读取「listStudents」所需数据，并遵守作用域、分页与容量边界。 */
async listStudents(ownerId?: string): Promise<ManagedModelStudentRecord[]> {
    return (await this.catalog.read())
      .filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item): item is ManagedModelStudentRecord => item.recordKind === "model_student")
      .filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => ownerId === undefined || item.ownerId === ownerId)
      .map(normalizeStudentRecord);
  }

  /** 读取「listConnections」所需数据，并遵守作用域、分页与容量边界。 */
async listConnections(ownerId?: string): Promise<ProviderConnectionRecord[]> {
    return (await this.catalog.read())
      .filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item): item is ProviderConnectionRecord => item.recordKind === "provider_connection")
      .filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => ownerId === undefined || item.ownerId === ownerId)
      .map(normalizeConnectionRecord);
  }

  /** 读取「getStudent」所需数据，并遵守作用域、分页与容量边界。 */
async getStudent(modelStudentId: string): Promise<ManagedModelStudentRecord | undefined> {
    return (await this.listStudents()).find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.modelStudentId === modelStudentId);
  }

  /** 读取「getConnection」所需数据，并遵守作用域、分页与容量边界。 */
async getConnection(connectionId: string): Promise<ProviderConnectionRecord | undefined> {
    return (await this.listConnections()).find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.connectionId === connectionId);
  }

  /** 执行「installed」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async installed(): Promise<Array<{ student: ManagedModelStudentRecord; connection: ProviderConnectionRecord }>> {
    const records = await this.catalog.read();
    const connectionRecords = records
      .filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item): item is ProviderConnectionRecord => item.recordKind === "provider_connection")
      .map(normalizeConnectionRecord);
    const studentRecords = records
      .filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item): item is ManagedModelStudentRecord => item.recordKind === "model_student")
      .map(normalizeStudentRecord);
    if (new Set(connectionRecords.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.connectionId)).size !== connectionRecords.length) {
      throw new Error("模型入园目录存在重复 ProviderConnection ID，已停止启动恢复");
    }
    if (new Set(studentRecords.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.modelStudentId)).size !== studentRecords.length) {
      throw new Error("模型入园目录存在重复 ModelStudent ID，已停止启动恢复");
    }
    const connections = new Map(connectionRecords.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => [item.connectionId, item]));
    return studentRecords
      .map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(student) => {
        const connection = connections.get(student.connectionId);
        if (!connection) throw new Error(`ModelStudent 缺少 ProviderConnection: ${student.modelStudentId}`);
        return { student, connection };
      });
  }

  /** 释放或删除「removeStudent」对应资源，重复调用仍保持安全。 */
async removeStudent(modelStudentId: string, ownerId: string): Promise<{
    student: ManagedModelStudentRecord;
    removedConnection?: ProviderConnectionRecord;
  } | undefined> {
    return this.catalog.update(/** 释放或删除「removeStudent」对应资源，重复调用仍保持安全。 */
(records) => {
      const student = records.find(
        /** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item): item is ManagedModelStudentRecord =>
          item.recordKind === "model_student" && item.modelStudentId === modelStudentId && item.ownerId === ownerId,
      );
      if (!student) return { records, result: undefined };
      const connectionStillUsed = records.some(
        /** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.recordKind === "model_student" &&
          item.modelStudentId !== student.modelStudentId && item.connectionId === student.connectionId,
      );
      const removedConnection = connectionStillUsed
        ? undefined
        : records.find(
          /** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item): item is ProviderConnectionRecord =>
            item.recordKind === "provider_connection" && item.connectionId === student.connectionId,
        );
      return {
        records: records.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) =>
          item !== student && (!removedConnection || item !== removedConnection)),
        result: { student, ...(removedConnection ? { removedConnection } : {}) },
      };
    });
  }

  /** 执行「connectionView」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
connectionView(value: ProviderConnectionRecord): ProviderConnectionView {
    return {
      schemaVersion: 1,
      connectionId: value.connectionId,
      ownerId: value.ownerId,
      protocol: value.protocol,
      presetId: value.presetId,
      baseUrl: value.baseUrl,
      credentialConfigured: value.credentialRef !== undefined,
      ...(value.credentialHint ? { credentialHint: value.credentialHint } : {}),
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    };
  }
}

/** 非法时间也按过期处理，避免损坏记录永久滞留。 */
function isExpired(expiresAt: string, now: number): boolean {
  const timestamp = Date.parse(expiresAt);
  return !Number.isFinite(timestamp) || timestamp <= now;
}

/** 判断「isTestRecord」对应条件，只返回判定结果且不修改输入状态。 */
function isTestRecord(value: unknown): value is ModelStudentTestRecord {
  if (!record(value) || value.schemaVersion !== 1 || typeof value.testId !== "string" || typeof value.ownerId !== "string") return false;
  if (!record(value.candidate) || !isReadyProtocol(value.candidate.protocol)) return false;
  if (typeof value.candidate.displayName !== "string" || typeof value.candidate.baseUrl !== "string" || typeof value.candidate.model !== "string") return false;
  if (value.candidate.presetId === undefined) {
    if (value.candidate.protocol !== "openai_responses") return false;
  } else if (!isReadyPresetProtocol(value.candidate.presetId, value.candidate.protocol)) return false;
  if (!(["testing", "succeeded", "failed", "expired"] as unknown[]).includes(value.state)) return false;
  if (typeof value.createdAt !== "string" || typeof value.expiresAt !== "string") return false;
  if (value.snapshot !== undefined) {
    try { readProviderCapabilitySnapshot(value.snapshot); } catch { return false; }
  }
  if (value.error !== undefined && (!record(value.error) || typeof value.error.code !== "string" || typeof value.error.message !== "string" || typeof value.error.retryable !== "boolean")) return false;
  return true;
}

/** 判断「isCatalogRecord」对应条件，只返回判定结果且不修改输入状态。 */
function isCatalogRecord(value: unknown): value is AdmissionCatalogRecord {
  if (!record(value) || value.schemaVersion !== 1 || typeof value.ownerId !== "string" || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") return false;
  if (value.recordKind === "provider_connection") {
    return typeof value.connectionId === "string" && isReadyProtocol(value.protocol) &&
      (value.presetId === undefined
        ? value.protocol === "openai_responses"
        : isReadyPresetProtocol(value.presetId, value.protocol)) &&
      typeof value.baseUrl === "string" &&
      (value.credentialHint === undefined || typeof value.credentialHint === "string") &&
      (value.credentialRef === undefined || isSecretRef(value.credentialRef));
  }
  if (value.recordKind !== "model_student") return false;
  if (typeof value.modelStudentId !== "string" || typeof value.connectionId !== "string" || typeof value.displayName !== "string" || typeof value.model !== "string" || (value.sizeClass !== "small" && value.sizeClass !== "large")) return false;
  if (value.contextWindowTokens !== undefined && (!Number.isSafeInteger(value.contextWindowTokens) || Number(value.contextWindowTokens) <= 0)) return false;
  if (value.lifecycle !== undefined && !["installing", "active", "archived", "capacity_blocked", "rollback_pending", "deleting"].includes(String(value.lifecycle))) return false;
  if (value.installationTestId !== undefined && typeof value.installationTestId !== "string") return false;
  try {
    const snapshot = readProviderCapabilitySnapshot(value.snapshot);
    if (value.generationDefaults === undefined) return true;
    if (!record(value.generationDefaults) || !isConcreteReasoningProfile(value.generationDefaults.reasoningProfile)) return false;
    return snapshot.reasoning.capability.supportedProfiles.includes(value.generationDefaults.reasoningProfile);
  } catch { return false; }
}

/** 校验并规范化「normalizeTestRecord」输入，非法数据直接返回明确错误。 */
function normalizeTestRecord(value: ModelStudentTestRecord): ModelStudentTestRecord {
  const candidate = value.candidate as ModelStudentTestRecord["candidate"] & { presetId?: ReadyModelProviderPresetId };
  return {
    ...structuredClone(value),
    candidate: {
      ...structuredClone(candidate),
      presetId: candidate.presetId ?? "custom_responses",
    },
    ...(value.snapshot ? { snapshot: readProviderCapabilitySnapshot(value.snapshot) } : {}),
  };
}

/** 校验并规范化「normalizeConnectionRecord」输入，非法数据直接返回明确错误。 */
function normalizeConnectionRecord(value: ProviderConnectionRecord): ProviderConnectionRecord {
  const legacy = value as ProviderConnectionRecord & { presetId?: ReadyModelProviderPresetId };
  return {
    ...structuredClone(value),
    presetId: legacy.presetId ?? "custom_responses",
  };
}

/** 校验并规范化「normalizeStudentRecord」输入，非法数据直接返回明确错误。 */
function normalizeStudentRecord(value: ManagedModelStudentRecord): ManagedModelStudentRecord {
  const snapshot = readProviderCapabilitySnapshot(value.snapshot);
  const legacy = value as ManagedModelStudentRecord & { generationDefaults?: ManagedModelStudentRecord["generationDefaults"] };
  return {
    ...structuredClone(value),
    generationDefaults: structuredClone(legacy.generationDefaults ?? {
      reasoningProfile: snapshot.reasoning.capability.defaultProfile,
    }),
    snapshot,
  };
}

/** 判断「isReadyProtocol」对应条件，只返回判定结果且不修改输入状态。 */
function isReadyProtocol(value: unknown): value is ProviderConnectionRecord["protocol"] {
  return value === "ollama_native" || value === "openai_responses" || value === "openai_chat_completions";
}

/** 判断「isReadyPreset」对应条件，只返回判定结果且不修改输入状态。 */
function isReadyPreset(value: unknown): value is ReadyModelProviderPresetId {
  return value === "ollama" || value === "openai" || value === "custom_responses" || value === "siliconflow";
}

/** 判断「isReadyPresetProtocol」对应条件，只返回判定结果且不修改输入状态。 */
function isReadyPresetProtocol(value: unknown, protocol: unknown): value is ReadyModelProviderPresetId {
  if (!isReadyPreset(value) || !isReadyProtocol(protocol)) return false;
  if (value === "ollama") return protocol === "ollama_native";
  return value === "siliconflow"
    ? protocol === "openai_chat_completions"
    : protocol === "openai_responses";
}

/** 判断「isSecretRef」对应条件，只返回判定结果且不修改输入状态。 */
function isSecretRef(value: unknown): value is SecretRef {
  return record(value) && (value.provider === "env" || value.provider === "managed" || value.provider === "keychain") && typeof value.key === "string";
}

/** 更新「record」对应状态，并保持写入顺序、原子性与容量约束。 */
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
