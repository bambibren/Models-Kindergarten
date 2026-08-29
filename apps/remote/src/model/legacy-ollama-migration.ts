import {
  normalizeLocalOllamaBaseUrl,
  type ProviderCapabilitySnapshot,
} from "@kindergarten/contracts";
import { connectionFingerprint } from "./model-admission-adapter-registry.js";
import type {
  ManagedModelStudentRecord,
  ModelAdmissionRepository,
  ProviderConnectionRecord,
} from "./model-admission-repository.js";

const DEFAULT_LEGACY_ID = "local-coder-student";

/** 把确实被历史 Session 引用的旧进程内 Ollama 模型转换为普通受管记录。 */
export class LegacyOllamaMigration {
  constructor(
    private readonly repository: ModelAdmissionRepository,
    private readonly modelInUse: (modelStudentId: string) => boolean | Promise<boolean>,
  ) {}

  async migrate(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
    const modelStudentId = env.MODEL_STUDENT_ID?.trim() || DEFAULT_LEGACY_ID;
    if (!await this.modelInUse(modelStudentId)) return false;
    if (await this.repository.getStudent(modelStudentId)) return false;

    const now = new Date().toISOString();
    const connectionId = `legacy-ollama-${modelStudentId}`;
    const baseUrl = normalizeLocalOllamaBaseUrl(env.OLLAMA_URL?.trim() || "http://127.0.0.1:11434");
    const model = env.OLLAMA_MODEL?.trim() || "qwen3:8b";
    const candidate = {
      presetId: "ollama" as const,
      protocol: "ollama_native" as const,
      baseUrl,
      model,
    };
    const connection: ProviderConnectionRecord = {
      schemaVersion: 1,
      recordKind: "provider_connection",
      connectionId,
      ownerId: "local-admin",
      presetId: "ollama",
      protocol: "ollama_native",
      baseUrl,
      createdAt: now,
      updatedAt: now,
    };
    const contextWindowTokens = positiveInteger(env.MODEL_CONTEXT_WINDOW_TOKENS);
    const student: ManagedModelStudentRecord = {
      schemaVersion: 1,
      recordKind: "model_student",
      modelStudentId,
      ownerId: "local-admin",
      connectionId,
      displayName: env.MODEL_STUDENT_NAME?.trim() || "本地编程小模型",
      model,
      sizeClass: env.MODEL_SIZE_CLASS === "large" ? "large" : "small",
      ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
      lifecycle: "active",
      generationDefaults: { reasoningProfile: "balanced" },
      snapshot: legacySnapshot(connectionFingerprint(candidate), now),
      createdAt: now,
      updatedAt: now,
    };
    await this.repository.install(connection, student);
    return true;
  }
}

function legacySnapshot(connectionId: string, testedAt: string): ProviderCapabilitySnapshot {
  return {
    schemaVersion: 1,
    protocol: "ollama_native",
    adapterRevision: "ollama-native-v1",
    probeVersion: 1,
    connectionFingerprint: connectionId,
    streaming: true,
    text: true,
    toolCalls: true,
    toolContinuation: true,
    usage: true,
    thought: true,
    reasoning: {
      capability: {
        schemaVersion: 1,
        control: "toggle",
        adjustable: true,
        supportedProfiles: ["fast", "balanced"],
        defaultProfile: "balanced",
        native: { parameter: "think", values: [false, true] },
      },
      nativeByProfile: { fast: { think: false }, balanced: { think: true } },
      acceptedNativeValues: [{ think: false }, { think: true }],
    },
    testedAt,
  };
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
