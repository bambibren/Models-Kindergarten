import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderCapabilitySnapshot } from "@kindergarten/contracts";
import { OllamaAdmissionAdapter } from "../../src/model/ollama-admission-adapter.js";

afterEach(() => vi.unstubAllGlobals());

describe("OllamaAdmissionAdapter", () => {
  it("通过真实模型目录体检并声明 Native 能力", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      models: [{ name: "qwen3:8b" }],
    }), { status: 200 })));
    const adapter = new OllamaAdmissionAdapter();
    const snapshot = await adapter.probe({
      presetId: "ollama",
      protocol: "ollama_native",
      displayName: "本机千问",
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen3:8b",
    });

    expect(snapshot).toMatchObject({
      protocol: "ollama_native",
      streaming: true,
      toolCalls: true,
      reasoning: {
        capability: { control: "toggle", supportedProfiles: ["fast", "balanced"] },
      },
    });
  });

  it("创建不依赖 API Key 的受管 Provider", () => {
    const adapter = new OllamaAdmissionAdapter();
    const provider = adapter.createProvider({
      schemaVersion: 1,
      recordKind: "model_student",
      modelStudentId: "student-local",
      ownerId: "local-admin",
      connectionId: "connection-local",
      displayName: "本机千问",
      model: "qwen3:8b",
      sizeClass: "small",
      lifecycle: "active",
      generationDefaults: { reasoningProfile: "balanced" },
      snapshot: snapshot(),
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:00.000Z",
    }, {
      schemaVersion: 1,
      recordKind: "provider_connection",
      connectionId: "connection-local",
      ownerId: "local-admin",
      presetId: "ollama",
      protocol: "ollama_native",
      baseUrl: "http://127.0.0.1:11434",
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:00.000Z",
    });

    expect(provider.student).toMatchObject({
      id: "student-local",
      sizeClass: "small",
      provider: { kind: "ollama", model: "qwen3:8b" },
    });
  });
});

function snapshot(): ProviderCapabilitySnapshot {
  return {
    schemaVersion: 1 as const,
    protocol: "ollama_native" as const,
    adapterRevision: "ollama-native-v1",
    probeVersion: 1,
    connectionFingerprint: "a".repeat(64),
    streaming: true,
    text: true,
    toolCalls: true,
    toolContinuation: true,
    usage: true,
    thought: true,
    reasoning: {
      capability: {
        schemaVersion: 1 as const,
        control: "toggle" as const,
        adjustable: true,
        supportedProfiles: ["fast", "balanced"],
        defaultProfile: "balanced" as const,
      },
      nativeByProfile: { fast: { think: false }, balanced: { think: true } },
      acceptedNativeValues: [{ think: false }, { think: true }],
    },
    testedAt: "2026-08-29T00:00:00.000Z",
  };
}
