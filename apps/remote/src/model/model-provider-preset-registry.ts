import {
  normalizeModelBaseUrl,
  type ModelProviderPresetView,
  type ModelStudentCandidateInput,
  type ReadyModelProviderPresetId,
  type ResolvedModelStudentCandidate,
} from "@kindergarten/contracts";
import type { ModelAdmissionAdapterRegistry, ReadyProviderProtocol } from "./model-admission-adapter-registry.js";

interface PresetDefinition extends ModelProviderPresetView {
  presetId: ReadyModelProviderPresetId | "anthropic";
}

const PRESETS: readonly PresetDefinition[] = [
  {
    schemaVersion: 1,
    presetId: "openai",
    displayName: "OpenAI",
    description: "OpenAI 官方 Responses API",
    protocol: "openai_responses",
    availability: "ready",
    baseUrl: { mode: "fixed", value: "https://api.openai.com/v1" },
    auth: { scheme: "bearer", apiKeyLabel: "API Key" },
    modelEntry: "manual",
  },
  {
    schemaVersion: 1,
    presetId: "custom_responses",
    displayName: "自定义 Responses API",
    description: "兼容 OpenAI Responses 协议的自定义服务",
    protocol: "openai_responses",
    availability: "ready",
    baseUrl: { mode: "editable" },
    auth: { scheme: "bearer", apiKeyLabel: "API Key" },
    modelEntry: "manual",
  },
  {
    schemaVersion: 1,
    presetId: "siliconflow",
    displayName: "硅基流动",
    description: "硅基流动 Chat Completions API",
    protocol: "openai_chat_completions",
    availability: "ready",
    baseUrl: { mode: "fixed", value: "https://api.siliconflow.cn/v1" },
    auth: { scheme: "bearer", apiKeyLabel: "API Key" },
    modelEntry: "manual",
  },
  {
    schemaVersion: 1,
    presetId: "anthropic",
    displayName: "Anthropic",
    description: "Anthropic Messages API",
    protocol: "anthropic_messages",
    availability: "planned",
    baseUrl: { mode: "fixed", value: "https://api.anthropic.com/v1" },
    auth: { scheme: "api_key_header", apiKeyLabel: "API Key" },
    modelEntry: "manual",
  },
] as const;

export class ModelProviderPresetRegistry {
  private readonly ready = new Map<ReadyModelProviderPresetId, PresetDefinition>();

  constructor(private readonly adapters: ModelAdmissionAdapterRegistry) {
    for (const preset of PRESETS) {
      if (preset.availability !== "ready") continue;
      const protocol = preset.protocol as ReadyProviderProtocol;
      if (!this.adapters.has(protocol)) {
        throw new Error(`ready 模型预设缺少协议适配器: ${preset.presetId} -> ${protocol}`);
      }
      if (this.ready.has(preset.presetId as ReadyModelProviderPresetId)) {
        throw new Error(`模型预设重复注册: ${preset.presetId}`);
      }
      this.ready.set(preset.presetId as ReadyModelProviderPresetId, preset);
    }
  }

  views(): ModelProviderPresetView[] {
    return [...this.ready.values()].map((item) => structuredClone(item));
  }

  resolve(input: ModelStudentCandidateInput): ResolvedModelStudentCandidate {
    const preset = this.ready.get(input.presetId);
    if (!preset) throw new Error(`模型预设当前不可用: ${input.presetId}`);
    const baseUrl = preset.baseUrl.mode === "fixed"
      ? preset.baseUrl.value
      : input.presetId === "custom_responses"
        ? input.baseUrl
        : undefined;
    if (!baseUrl) throw new Error(`模型预设缺少 Base URL: ${input.presetId}`);
    return {
      presetId: input.presetId,
      protocol: preset.protocol as ReadyProviderProtocol,
      displayName: input.displayName,
      baseUrl: normalizeModelBaseUrl(baseUrl),
      model: input.model,
      apiKey: input.apiKey,
    };
  }
}
