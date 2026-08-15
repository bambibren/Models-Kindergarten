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

export interface ResponsesCapabilityProbePort {
  probe(candidate: ResponsesModelCandidateInput): Promise<ProviderCapabilitySnapshot>;
}

export type ResponsesProviderFactory = (
  student: ManagedModelStudentRecord,
  connection: ProviderConnectionRecord,
) => ModelProvider;

/** Responses 专有输入/Provider 构造只停留在这个适配器内。 */
export class ResponsesAdmissionAdapter implements ModelAdmissionAdapter {
  readonly protocol = "openai_responses" as const;
  readonly adapterRevision = "openai-responses-v1";
  readonly probeVersion = 1;

  constructor(
    private readonly prober: ResponsesCapabilityProbePort,
    private readonly create: ResponsesProviderFactory,
  ) {}

  probe(candidate: Parameters<ModelAdmissionAdapter["probe"]>[0]): Promise<ProviderCapabilitySnapshot> {
    if (candidate.protocol !== this.protocol) throw new Error("Responses adapter 收到错误协议候选");
    return this.prober.probe({
      displayName: candidate.displayName,
      baseUrl: candidate.baseUrl,
      model: candidate.model,
      apiKey: candidate.apiKey,
    });
  }

  createProvider(
    student: ManagedModelStudentRecord,
    connection: ProviderConnectionRecord,
  ): ModelProvider {
    if (connection.protocol !== this.protocol) throw new Error("Responses adapter 收到错误协议连接");
    return this.create(student, connection);
  }
}
