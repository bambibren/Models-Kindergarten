import {
  normalizeLocalOllamaBaseUrl,
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
    presetId: "ollama",
    displayName: "本机 Ollama",
    description: "当前设备上运行的 Ollama Native API；仅用于本地开发",
    protocol: "ollama_native",
    availability: "ready",
    baseUrl: { mode: "editable", defaultValue: "http://127.0.0.1:11434" },
    auth: { scheme: "none", apiKeyLabel: "不需要 API Key" },
    modelEntry: "manual",
  },
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

/** 描述「ModelProviderPresetRegistry」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export class ModelProviderPresetRegistry {
  private readonly ready = new Map<ReadyModelProviderPresetId, PresetDefinition>();

  /** 初始化「ModelProviderPresetRegistry」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(private readonly adapters: ModelAdmissionAdapterRegistry) {
    for (const preset of PRESETS) {
      if (preset.availability !== "ready") continue;
      const protocol = preset.protocol as ReadyProviderProtocol;
      // 测试或裁剪部署可以只注册部分协议；对外只发布当前进程真正能创建的 Provider。
      if (!this.adapters.has(protocol)) continue;
      if (this.ready.has(preset.presetId as ReadyModelProviderPresetId)) {
        throw new Error(`模型预设重复注册: ${preset.presetId}`);
      }
      this.ready.set(preset.presetId as ReadyModelProviderPresetId, preset);
    }
  }

  /** 执行「views」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
views(): ModelProviderPresetView[] {
    return [...this.ready.values()].map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => structuredClone(item));
  }

  /** 执行「resolve」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
resolve(input: ModelStudentCandidateInput): ResolvedModelStudentCandidate {
    const preset = this.ready.get(input.presetId);
    if (!preset) throw new Error(`模型预设当前不可用: ${input.presetId}`);
    const baseUrl = preset.baseUrl.mode === "fixed"
      ? preset.baseUrl.value
      : input.presetId === "custom_responses" || input.presetId === "ollama"
        ? input.baseUrl
        : undefined;
    if (!baseUrl) throw new Error(`模型预设缺少 Base URL: ${input.presetId}`);
    return {
      presetId: input.presetId,
      protocol: preset.protocol as ReadyProviderProtocol,
      displayName: input.displayName,
      baseUrl: input.presetId === "ollama"
        ? normalizeLocalOllamaBaseUrl(baseUrl)
        : normalizeModelBaseUrl(baseUrl),
      model: input.model,
      ...("apiKey" in input ? { apiKey: input.apiKey } : {}),
    };
  }
}
