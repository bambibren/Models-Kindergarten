import type {
  ProviderCapabilitySnapshot,
  ResolvedModelStudentCandidate,
} from "@kindergarten/contracts";
import type { ModelAdmissionAdapter } from "./model-admission-adapter-registry.js";
import type {
  ManagedModelStudentRecord,
  ProviderConnectionRecord,
} from "./model-admission-repository.js";
import { OllamaProvider } from "./ollama-provider.js";

/** Ollama Native 入园只连接当前设备回环地址，不读取 SecretStore。 */
export class OllamaAdmissionAdapter implements ModelAdmissionAdapter {
  readonly protocol = "ollama_native" as const;
  readonly adapterRevision = "ollama-native-v1";
  readonly probeVersion = 1;

  async probe(candidate: ResolvedModelStudentCandidate): Promise<ProviderCapabilitySnapshot> {
    if (candidate.presetId !== "ollama" || candidate.protocol !== "ollama_native") {
      throw new Error("Ollama Adapter 收到了不匹配的候选模型");
    }
    const provider = new OllamaProvider({
      id: "ollama-admission-probe",
      name: candidate.displayName,
      sizeClass: "small",
      provider: {
        kind: "ollama",
        baseUrl: candidate.baseUrl,
        model: candidate.model,
      },
      generationDefaults: { reasoningProfile: "balanced" },
    });
    await provider.verify();
    return {
      schemaVersion: 1,
      protocol: "ollama_native",
      adapterRevision: this.adapterRevision,
      probeVersion: this.probeVersion,
      connectionFingerprint: "pending-registry-binding",
      streaming: true,
      text: true,
      toolCalls: true,
      toolContinuation: true,
      usage: true,
      thought: true,
      reasoning: {
        capability: provider.reasoningCapability,
        nativeByProfile: {
          fast: provider.nativeReasoning("fast"),
          balanced: provider.nativeReasoning("balanced"),
        },
        acceptedNativeValues: [
          provider.nativeReasoning("fast"),
          provider.nativeReasoning("balanced"),
        ],
      },
      testedAt: new Date().toISOString(),
    };
  }

  createProvider(
    student: ManagedModelStudentRecord,
    connection: ProviderConnectionRecord,
  ): OllamaProvider {
    if (connection.presetId !== "ollama" || connection.protocol !== "ollama_native") {
      throw new Error(`Ollama ModelStudent 连接协议不匹配: ${student.modelStudentId}`);
    }
    return new OllamaProvider({
      id: student.modelStudentId,
      name: student.displayName,
      sizeClass: student.sizeClass,
      ...(student.contextWindowTokens === undefined ? {} : { contextWindowTokens: student.contextWindowTokens }),
      provider: {
        kind: "ollama",
        baseUrl: connection.baseUrl,
        model: student.model,
      },
      generationDefaults: structuredClone(student.generationDefaults),
    });
  }
}
