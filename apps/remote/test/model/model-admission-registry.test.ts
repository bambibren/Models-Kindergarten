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

describe("provider-neutral model admission registry", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("只发布已有真实协议适配器的 ready 预设，不发布未来 Anthropic", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const adapters = registry();
    expect(new ModelProviderPresetRegistry(adapters).views().map(/** 构造「toEqual」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(item) => item.presetId))
      .toEqual(["openai", "custom_responses", "siliconflow"]);
  });

  it("不发布或接受新的本机 Ollama 入园预设", () => {
    const presets = new ModelProviderPresetRegistry(new ModelAdmissionAdapterRegistry([
      adapter("ollama_native"),
    ]));
    expect(presets.views()).toEqual([]);
    expect(() => presets.resolve({
      presetId: "ollama",
      displayName: "本机模型",
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen3:8b",
    })).toThrow("模型预设当前不可用: ollama");
  });

  it("固定预设由 Remote 解析官方地址，自定义预设才接收输入地址", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
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

  it("按协议分发体检，并由 registry 写入版本及不含 Secret 的稳定连接指纹", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const seen: ResolvedModelStudentCandidate[] = [];
    const adapters = registry(/** 构造「adapters」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(candidate) => { seen.push(candidate); });
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

  it("拒绝重复协议，并只发布当前进程已注册的协议", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const responses = adapter("openai_responses");
    expect(/** 构造「toThrow」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => new ModelAdmissionAdapterRegistry([responses, responses])).toThrow("重复注册");
    const onlyResponses = new ModelAdmissionAdapterRegistry([responses]);
    expect(new ModelProviderPresetRegistry(onlyResponses).views().map((item) => item.presetId))
      .toEqual(["openai", "custom_responses"]);
  });
});

/** 构造「registry」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function registry(onProbe?: (candidate: ResolvedModelStudentCandidate) => void) {
  return new ModelAdmissionAdapterRegistry([
    adapter("openai_responses", onProbe),
    adapter("openai_chat_completions", onProbe),
  ]);
}

/** 构造「adapter」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function adapter(
  protocol: ModelAdmissionAdapter["protocol"],
  onProbe?: (candidate: ResolvedModelStudentCandidate) => void,
): ModelAdmissionAdapter {
  return {
    protocol,
    adapterRevision: protocol === "openai_responses" ? "responses-test-v2" : "chat-test-v1",
    probeVersion: protocol === "openai_responses" ? 2 : 1,
    probe: /** 构造「probe」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async (candidate) => {
      onProbe?.(candidate);
      return snapshot(protocol);
    },
    createProvider: /** 构造「createProvider」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => new FixtureProvider(),
  };
}

/** 构造「snapshot」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
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
