import type {
  ProviderCapabilitySnapshot,
  ResponsesModelCandidateInput,
} from "@kindergarten/contracts";
import type { ModelProvider } from "./model-provider.js";
import type {
  ManagedModelStudentRecord,
  ProviderConnectionRecord,
} from "./model-admission-repository.js";
import type { ModelAdmissionAdapter } from "./model-admission-adapter-registry.js";

/** 描述「ResponsesCapabilityProbePort」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ResponsesCapabilityProbePort {
  probe(candidate: ResponsesModelCandidateInput): Promise<ProviderCapabilitySnapshot>;
}

/** 描述「ResponsesProviderFactory」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ResponsesProviderFactory = (
  student: ManagedModelStudentRecord,
  connection: ProviderConnectionRecord,
) => ModelProvider;

/** Responses 专有输入/Provider 构造只停留在这个适配器内。 */
export class ResponsesAdmissionAdapter implements ModelAdmissionAdapter {
  readonly protocol = "openai_responses" as const;
  readonly adapterRevision = "openai-responses-v1";
  readonly probeVersion = 1;

  /** 初始化「ResponsesAdmissionAdapter」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(
    private readonly prober: ResponsesCapabilityProbePort,
    private readonly create: ResponsesProviderFactory,
  ) {}

  /** 执行「probe」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
probe(candidate: Parameters<ModelAdmissionAdapter["probe"]>[0]): Promise<ProviderCapabilitySnapshot> {
    if (candidate.protocol !== this.protocol) throw new Error("Responses adapter 收到错误协议候选");
    return this.prober.probe({
      displayName: candidate.displayName,
      baseUrl: candidate.baseUrl,
      model: candidate.model,
      apiKey: candidate.apiKey,
    });
  }

  /** 根据已校验输入构建「createProvider」结果，不额外持有调用方的大对象。 */
createProvider(
    student: ManagedModelStudentRecord,
    connection: ProviderConnectionRecord,
  ): ModelProvider {
    if (connection.protocol !== this.protocol) throw new Error("Responses adapter 收到错误协议连接");
    return this.create(student, connection);
  }
}
