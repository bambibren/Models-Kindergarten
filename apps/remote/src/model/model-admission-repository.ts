import {
  isConcreteReasoningProfile,
  readProviderCapabilitySnapshot,
  type ConcreteReasoningProfile,
  type ProviderCapabilitySnapshot,
  type ReadyModelProviderPresetId,
  type ModelStudentTestRecord,
  type ProviderConnectionView,
} from "@kindergarten/contracts";
import type { SecretRef } from "../mcp/mcp-types.js";
import { AtomicJsonStore } from "../storage/atomic-json-store.js";

export interface ProviderConnectionRecord {
  schemaVersion: 1;
  recordKind: "provider_connection";
  connectionId: string;
  ownerId: string;
  presetId: ReadyModelProviderPresetId;
  protocol: "openai_responses" | "openai_chat_completions";
  baseUrl: string;
  credentialRef: SecretRef;
  credentialHint: string;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedModelStudentRecord {
  schemaVersion: 1;
  recordKind: "model_student";
  modelStudentId: string;
  ownerId: string;
  connectionId: string;
  displayName: string;
  model: string;
  sizeClass: "large";
  /** 旧记录缺省视为 active；新事务必须显式写入。 */
  lifecycle?: "installing" | "active" | "rollback_pending" | "deleting";
  installationTestId?: string;
  generationDefaults: {
    reasoningProfile: ConcreteReasoningProfile;
  };
  snapshot: ProviderCapabilitySnapshot;
  createdAt: string;
  updatedAt: string;
}

type AdmissionCatalogRecord = ProviderConnectionRecord | ManagedModelStudentRecord;

export class ModelAdmissionConflictError extends Error {
  constructor(readonly reason: "duplicate_id" | "duplicate_test" | "duplicate_model", message: string) {
    super(message);
  }
}

/** 测试记录与安装聚合分开存；安装时 Connection + ModelStudent 在一次原子提交中落盘。 */
export class ModelAdmissionRepository {
  private readonly tests: AtomicJsonStore<ModelStudentTestRecord>;
  private readonly catalog: AtomicJsonStore<AdmissionCatalogRecord>;

  constructor(testsFile: string, catalogFile: string) {
    this.tests = new AtomicJsonStore({ file: testsFile, schemaVersion: 1, validate: isTestRecord });
    this.catalog = new AtomicJsonStore({ file: catalogFile, schemaVersion: 1, validate: isCatalogRecord });
  }

  async putTest(value: ModelStudentTestRecord): Promise<void> {
    await this.tests.update((records) => [
      ...records.filter((item) => item.testId !== value.testId),
      structuredClone(value),
    ]);
  }

  /** 启动时一次性固化旧受管模型缺失的模型侧默认配置。 */
  async persistMigrations(): Promise<void> {
    await this.catalog.update((records) => records.map((item) => {
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

  async getTest(testId: string): Promise<ModelStudentTestRecord | undefined> {
    const item = (await this.tests.read()).find((candidate) => candidate.testId === testId);
    return item ? normalizeTestRecord(item) : undefined;
  }

  async install(connection: ProviderConnectionRecord, student: ManagedModelStudentRecord): Promise<void> {
    if (connection.connectionId !== student.connectionId || connection.ownerId !== student.ownerId) {
      throw new Error("ProviderConnection 与 ModelStudent 归属不一致");
    }
    await this.catalog.update((records) => {
      if (records.some((item) => item.recordKind === "provider_connection" && item.connectionId === connection.connectionId)) {
        throw new ModelAdmissionConflictError("duplicate_id", `ProviderConnection 已存在: ${connection.connectionId}`);
      }
      if (records.some((item) => item.recordKind === "model_student" && item.modelStudentId === student.modelStudentId)) {
        throw new ModelAdmissionConflictError("duplicate_id", `ModelStudent 已存在: ${student.modelStudentId}`);
      }
      if (student.installationTestId && records.some((item) =>
        item.recordKind === "model_student" && item.installationTestId === student.installationTestId,
      )) {
        throw new ModelAdmissionConflictError("duplicate_test", "同一模型测试已经完成过入园");
      }
      const connections = new Map(records
        .filter((item): item is ProviderConnectionRecord => item.recordKind === "provider_connection")
        .map((item) => [item.connectionId, item]));
      if (records.some((item) => {
        if (item.recordKind !== "model_student" || item.ownerId !== student.ownerId || item.model !== student.model) return false;
        const existing = connections.get(item.connectionId);
        return existing?.baseUrl === connection.baseUrl && existing.protocol === connection.protocol;
      })) {
        throw new ModelAdmissionConflictError("duplicate_model", "该 Provider 模型已经入园或正在处理");
      }
      return [...records, structuredClone(connection), structuredClone(student)];
    });
  }

  async setLifecycle(
    modelStudentId: string,
    ownerId: string,
    lifecycle: NonNullable<ManagedModelStudentRecord["lifecycle"]>,
  ): Promise<ManagedModelStudentRecord> {
    const result = await this.catalog.update((records) => {
      const index = records.findIndex((item) => item.recordKind === "model_student" && item.modelStudentId === modelStudentId && item.ownerId === ownerId);
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

  async setSnapshot(
    modelStudentId: string,
    ownerId: string,
    snapshot: ProviderCapabilitySnapshot,
  ): Promise<ManagedModelStudentRecord> {
    const normalized = readProviderCapabilitySnapshot(snapshot);
    const result = await this.catalog.update((records) => {
      const index = records.findIndex((item) => item.recordKind === "model_student" && item.modelStudentId === modelStudentId && item.ownerId === ownerId);
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

  async listStudents(ownerId?: string): Promise<ManagedModelStudentRecord[]> {
    return (await this.catalog.read())
      .filter((item): item is ManagedModelStudentRecord => item.recordKind === "model_student")
      .filter((item) => ownerId === undefined || item.ownerId === ownerId)
      .map(normalizeStudentRecord);
  }

  async listConnections(ownerId?: string): Promise<ProviderConnectionRecord[]> {
    return (await this.catalog.read())
      .filter((item): item is ProviderConnectionRecord => item.recordKind === "provider_connection")
      .filter((item) => ownerId === undefined || item.ownerId === ownerId)
      .map(normalizeConnectionRecord);
  }

  async getStudent(modelStudentId: string): Promise<ManagedModelStudentRecord | undefined> {
    return (await this.listStudents()).find((item) => item.modelStudentId === modelStudentId);
  }

  async getConnection(connectionId: string): Promise<ProviderConnectionRecord | undefined> {
    return (await this.listConnections()).find((item) => item.connectionId === connectionId);
  }

  async installed(): Promise<Array<{ student: ManagedModelStudentRecord; connection: ProviderConnectionRecord }>> {
    const records = await this.catalog.read();
    const connectionRecords = records
      .filter((item): item is ProviderConnectionRecord => item.recordKind === "provider_connection")
      .map(normalizeConnectionRecord);
    const studentRecords = records
      .filter((item): item is ManagedModelStudentRecord => item.recordKind === "model_student")
      .map(normalizeStudentRecord);
    if (new Set(connectionRecords.map((item) => item.connectionId)).size !== connectionRecords.length) {
      throw new Error("模型入园目录存在重复 ProviderConnection ID，已停止启动恢复");
    }
    if (new Set(studentRecords.map((item) => item.modelStudentId)).size !== studentRecords.length) {
      throw new Error("模型入园目录存在重复 ModelStudent ID，已停止启动恢复");
    }
    const connections = new Map(connectionRecords.map((item) => [item.connectionId, item]));
    return studentRecords
      .map((student) => {
        const connection = connections.get(student.connectionId);
        if (!connection) throw new Error(`ModelStudent 缺少 ProviderConnection: ${student.modelStudentId}`);
        return { student, connection };
      });
  }

  async removeStudent(modelStudentId: string, ownerId: string): Promise<{
    student: ManagedModelStudentRecord;
    removedConnection?: ProviderConnectionRecord;
  } | undefined> {
    return this.catalog.update((records) => {
      const student = records.find(
        (item): item is ManagedModelStudentRecord =>
          item.recordKind === "model_student" && item.modelStudentId === modelStudentId && item.ownerId === ownerId,
      );
      if (!student) return { records, result: undefined };
      const connectionStillUsed = records.some(
        (item) => item.recordKind === "model_student" &&
          item.modelStudentId !== student.modelStudentId && item.connectionId === student.connectionId,
      );
      const removedConnection = connectionStillUsed
        ? undefined
        : records.find(
          (item): item is ProviderConnectionRecord =>
            item.recordKind === "provider_connection" && item.connectionId === student.connectionId,
        );
      return {
        records: records.filter((item) =>
          item !== student && (!removedConnection || item !== removedConnection)),
        result: { student, ...(removedConnection ? { removedConnection } : {}) },
      };
    });
  }

  connectionView(value: ProviderConnectionRecord): ProviderConnectionView {
    return {
      schemaVersion: 1,
      connectionId: value.connectionId,
      ownerId: value.ownerId,
      protocol: value.protocol,
      presetId: value.presetId,
      baseUrl: value.baseUrl,
      credentialConfigured: true,
      credentialHint: value.credentialHint,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    };
  }
}

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

function isCatalogRecord(value: unknown): value is AdmissionCatalogRecord {
  if (!record(value) || value.schemaVersion !== 1 || typeof value.ownerId !== "string" || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") return false;
  if (value.recordKind === "provider_connection") {
    return typeof value.connectionId === "string" && isReadyProtocol(value.protocol) &&
      (value.presetId === undefined
        ? value.protocol === "openai_responses"
        : isReadyPresetProtocol(value.presetId, value.protocol)) &&
      typeof value.baseUrl === "string" && typeof value.credentialHint === "string" && isSecretRef(value.credentialRef);
  }
  if (value.recordKind !== "model_student") return false;
  if (typeof value.modelStudentId !== "string" || typeof value.connectionId !== "string" || typeof value.displayName !== "string" || typeof value.model !== "string" || value.sizeClass !== "large") return false;
  if (value.lifecycle !== undefined && !["installing", "active", "rollback_pending", "deleting"].includes(String(value.lifecycle))) return false;
  if (value.installationTestId !== undefined && typeof value.installationTestId !== "string") return false;
  try {
    const snapshot = readProviderCapabilitySnapshot(value.snapshot);
    if (value.generationDefaults === undefined) return true;
    if (!record(value.generationDefaults) || !isConcreteReasoningProfile(value.generationDefaults.reasoningProfile)) return false;
    return snapshot.reasoning.capability.supportedProfiles.includes(value.generationDefaults.reasoningProfile);
  } catch { return false; }
}

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

function normalizeConnectionRecord(value: ProviderConnectionRecord): ProviderConnectionRecord {
  const legacy = value as ProviderConnectionRecord & { presetId?: ReadyModelProviderPresetId };
  return {
    ...structuredClone(value),
    presetId: legacy.presetId ?? "custom_responses",
  };
}

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

function isReadyProtocol(value: unknown): value is ProviderConnectionRecord["protocol"] {
  return value === "openai_responses" || value === "openai_chat_completions";
}

function isReadyPreset(value: unknown): value is ReadyModelProviderPresetId {
  return value === "openai" || value === "custom_responses" || value === "siliconflow";
}

function isReadyPresetProtocol(value: unknown, protocol: unknown): value is ReadyModelProviderPresetId {
  if (!isReadyPreset(value) || !isReadyProtocol(protocol)) return false;
  return value === "siliconflow"
    ? protocol === "openai_chat_completions"
    : protocol === "openai_responses";
}

function isSecretRef(value: unknown): value is SecretRef {
  return record(value) && (value.provider === "env" || value.provider === "keychain") && typeof value.key === "string";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
