import { describe, expect, it } from "vitest";
import type {
  ProviderCapabilitySnapshot,
  ResolvedModelStudentCandidate,
} from "@kindergarten/contracts";
import {
  ModelAdmissionAdapterRegistry,
  type ModelAdmissionAdapter,
} from "../../src/model/model-admission-adapter-registry.js";
import { ModelProviderPresetRegistry } from "../../src/model/model-provider-preset-registry.js";
import { FixtureProvider } from "../../src/model/fixture-provider.js";

describe("provider-neutral model admission registry", () => {
  it("只发布已有真实协议适配器的 ready 预设，不发布未来 Anthropic", () => {
    const adapters = registry();
    expect(new ModelProviderPresetRegistry(adapters).views().map((item) => item.presetId))
      .toEqual(["openai", "custom_responses", "siliconflow"]);
  });

  it("固定预设由 Remote 解析官方地址，自定义预设才接收输入地址", () => {
    const presets = new ModelProviderPresetRegistry(registry());
    expect(presets.resolve({
      presetId: "openai", displayName: "OpenAI", model: "gpt-x", apiKey: "k",
    })).toMatchObject({ baseUrl: "https://api.openai.com/v1", protocol: "openai_responses" });
    expect(presets.resolve({
      presetId: "siliconflow", displayName: "SF", model: "vendor/model", apiKey: "k",
    })).toMatchObject({ baseUrl: "https://api.siliconflow.cn/v1", protocol: "openai_chat_completions" });
    expect(presets.resolve({
      presetId: "custom_responses",
      displayName: "Custom",
      baseUrl: "https://models.example/v1/",
      model: "gpt-x",
      apiKey: "k",
    }).baseUrl).toBe("https://models.example/v1");
  });

  it("按协议分发体检，并由 registry 写入版本及不含 Secret 的稳定连接指纹", async () => {
    const seen: ResolvedModelStudentCandidate[] = [];
    const adapters = registry((candidate) => { seen.push(candidate); });
    const candidate = new ModelProviderPresetRegistry(adapters).resolve({
      presetId: "openai",
      displayName: "OpenAI",
      model: "gpt-x",
      apiKey: "SECRET_SENTINEL",
    });
    const snapshot = await adapters.probe(candidate);
    expect(seen).toHaveLength(1);
    expect(snapshot).toMatchObject({
      protocol: "openai_responses",
      adapterRevision: "responses-test-v2",
      probeVersion: 2,
    });
    expect(snapshot.connectionFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(snapshot)).not.toContain(candidate.apiKey);
  });

  it("启动时拒绝重复协议和缺失 ready 协议", () => {
    const responses = adapter("openai_responses");
    expect(() => new ModelAdmissionAdapterRegistry([responses, responses])).toThrow("重复注册");
    const onlyResponses = new ModelAdmissionAdapterRegistry([responses]);
    expect(() => new ModelProviderPresetRegistry(onlyResponses)).toThrow("缺少协议适配器");
  });
});

function registry(onProbe?: (candidate: ResolvedModelStudentCandidate) => void) {
  return new ModelAdmissionAdapterRegistry([
    adapter("openai_responses", onProbe),
    adapter("openai_chat_completions", onProbe),
  ]);
}

function adapter(
  protocol: ModelAdmissionAdapter["protocol"],
  onProbe?: (candidate: ResolvedModelStudentCandidate) => void,
): ModelAdmissionAdapter {
  return {
    protocol,
    adapterRevision: protocol === "openai_responses" ? "responses-test-v2" : "chat-test-v1",
    probeVersion: protocol === "openai_responses" ? 2 : 1,
    probe: async (candidate) => {
      onProbe?.(candidate);
      return snapshot(protocol);
    },
    createProvider: () => new FixtureProvider(),
  };
}

function snapshot(protocol: ModelAdmissionAdapter["protocol"]): ProviderCapabilitySnapshot {
  return {
    schemaVersion: 1,
    protocol,
    adapterRevision: "raw",
    probeVersion: 1,
    connectionFingerprint: "raw",
    streaming: true,
    text: true,
    toolCalls: true,
    toolContinuation: true,
    usage: true,
    thought: false,
    reasoning: {
      capability: {
        schemaVersion: 1,
        control: "fixed",
        adjustable: false,
        supportedProfiles: ["balanced"],
        defaultProfile: "balanced",
      },
      nativeByProfile: { balanced: {} },
      acceptedNativeValues: [{}],
    },
    testedAt: "2026-08-14T00:00:00.000Z",
  };
}
