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

/** 描述「ReadyProviderProtocol」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ReadyProviderProtocol = Exclude<ProviderProtocol, "anthropic_messages">;

/** 描述「ModelAdmissionAdapter」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
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

  /** 初始化「ModelAdmissionAdapterRegistry」所需依赖，不在构造阶段启动不可回收的后台任务。 */
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

  /** 判断「has」对应条件，只返回判定结果且不修改输入状态。 */
has(protocol: ReadyProviderProtocol): boolean {
    return this.adapters.has(protocol);
  }

  /** 校验并取得「require」所需对象；缺失或归属不符时立即抛出明确错误。 */
require(protocol: ReadyProviderProtocol): ModelAdmissionAdapter {
    const adapter = this.adapters.get(protocol);
    if (!adapter) throw new Error(`模型入园协议适配器未注册: ${protocol}`);
    return adapter;
  }

  /** 执行「probe」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async probe(candidate: ResolvedModelStudentCandidate): Promise<ProviderCapabilitySnapshot> {
    const adapter = this.require(candidate.protocol);
    const raw = await adapter.probe(candidate);
    const snapshot = this.bindSnapshot(raw, candidate);
    if (snapshot.protocol !== candidate.protocol) {
      throw new Error(`体检协议不匹配: expected=${candidate.protocol}, actual=${snapshot.protocol}`);
    }
    return snapshot;
  }

  /** 生成「bindSnapshot」不可变视图，隔离后续状态修改并只暴露该层需要的事实。 */
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

  /** 根据已校验输入构建「createProvider」结果，不额外持有调用方的大对象。 */
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

/** 执行「connectionFingerprint」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function connectionFingerprint(candidate: Pick<
  ResolvedModelStudentCandidate,
  "presetId" | "protocol" | "baseUrl" | "model"
>): string {
  return createHash("sha256")
    .update([candidate.presetId, candidate.protocol, candidate.baseUrl, candidate.model].join("\u0000"))
    .digest("hex");
}
