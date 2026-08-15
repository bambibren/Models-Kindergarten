import { createHash } from "node:crypto";
import {
  readProviderCapabilitySnapshot,
  type ProviderCapabilitySnapshot,
  type ProviderProtocol,
  type ResolvedModelStudentCandidate,
} from "@kindergarten/contracts";
import type { ModelProvider } from "./model-provider.js";
import type {
  ManagedModelStudentRecord,
  ProviderConnectionRecord,
} from "./model-admission-repository.js";

export type ReadyProviderProtocol = Exclude<ProviderProtocol, "anthropic_messages">;

export interface ModelAdmissionAdapter {
  readonly protocol: ReadyProviderProtocol;
  readonly adapterRevision: string;
  readonly probeVersion: number;
  probe(candidate: ResolvedModelStudentCandidate): Promise<ProviderCapabilitySnapshot>;
  createProvider(
    student: ManagedModelStudentRecord,
    connection: ProviderConnectionRecord,
  ): ModelProvider;
}

/** 协议选择的唯一入口；Service 不再知道 Responses 或 Chat Completions 的实现类。 */
export class ModelAdmissionAdapterRegistry {
  private readonly adapters = new Map<ReadyProviderProtocol, ModelAdmissionAdapter>();

  constructor(adapters: readonly ModelAdmissionAdapter[]) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.protocol)) {
        throw new Error(`模型入园协议适配器重复注册: ${adapter.protocol}`);
      }
      if (!adapter.adapterRevision.trim() || !Number.isInteger(adapter.probeVersion) || adapter.probeVersion < 1) {
        throw new Error(`模型入园协议适配器版本无效: ${adapter.protocol}`);
      }
      this.adapters.set(adapter.protocol, adapter);
    }
  }

  has(protocol: ReadyProviderProtocol): boolean {
    return this.adapters.has(protocol);
  }

  require(protocol: ReadyProviderProtocol): ModelAdmissionAdapter {
    const adapter = this.adapters.get(protocol);
    if (!adapter) throw new Error(`模型入园协议适配器未注册: ${protocol}`);
    return adapter;
  }

  async probe(candidate: ResolvedModelStudentCandidate): Promise<ProviderCapabilitySnapshot> {
    const adapter = this.require(candidate.protocol);
    const raw = await adapter.probe(candidate);
    const snapshot = this.bindSnapshot(raw, candidate);
    if (snapshot.protocol !== candidate.protocol) {
      throw new Error(`体检协议不匹配: expected=${candidate.protocol}, actual=${snapshot.protocol}`);
    }
    return snapshot;
  }

  bindSnapshot(
    snapshot: ProviderCapabilitySnapshot,
    identity: Pick<ResolvedModelStudentCandidate, "presetId" | "protocol" | "baseUrl" | "model">,
  ): ProviderCapabilitySnapshot {
    const adapter = this.require(identity.protocol);
    return readProviderCapabilitySnapshot({
      ...snapshot,
      adapterRevision: adapter.adapterRevision,
      probeVersion: adapter.probeVersion,
      connectionFingerprint: connectionFingerprint(identity),
    });
  }

  createProvider(
    student: ManagedModelStudentRecord,
    connection: ProviderConnectionRecord,
  ): ModelProvider {
    if (student.snapshot.protocol !== connection.protocol) {
      throw new Error(`ModelStudent 快照与连接协议不匹配: ${student.modelStudentId}`);
    }
    return this.require(connection.protocol).createProvider(student, connection);
  }
}

export function connectionFingerprint(candidate: Pick<
  ResolvedModelStudentCandidate,
  "presetId" | "protocol" | "baseUrl" | "model"
>): string {
  return createHash("sha256")
    .update([candidate.presetId, candidate.protocol, candidate.baseUrl, candidate.model].join("\u0000"))
    .digest("hex");
}
