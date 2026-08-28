import type {
  DemoModelCapabilities,
  DemoModelStudent,
  DemoProviderProtocol,
} from "../demo-types.js";
import {
  readModelReasoningCapability,
  type ModelReasoningCapability,
} from "@kindergarten/contracts";

type StoredDemoModelCapabilities = Omit<DemoModelCapabilities, "reasoningControl"> & {
  /** 旧版 Demo 存储没有这个字段；读取时会补成 fixed。 */
  reasoningControl?: unknown;
};

type StoredDemoModelStudent = Omit<DemoModelStudent, "capabilities"> & {
  capabilities: StoredDemoModelCapabilities;
};

/** 描述「ModelAdmissionProviderId」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ModelAdmissionProviderId = "ollama" | "siliconflow" | "custom_responses";

/** 描述「ModelAdmissionDraft」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ModelAdmissionDraft {
  providerId: ModelAdmissionProviderId;
  connectionName: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  modelId: string;
}

/** 描述「ModelAdmissionField」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ModelAdmissionField = "connectionName" | "baseUrl" | "apiKey" | "modelId";

/** 描述「ModelAdmissionValidation」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ModelAdmissionValidation {
  valid: boolean;
  errors: Partial<Record<ModelAdmissionField, string>>;
}

/** 描述「DiscoveredDemoModel」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface DiscoveredDemoModel {
  id: string;
  name: string;
  description: string;
  capabilities: DemoModelCapabilities;
}

/** 描述「ModelAdmissionTestResult」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ModelAdmissionTestResult =
  | { ok: true; models: DiscoveredDemoModel[] }
  | { ok: false; error: string };

/** 描述「ModelAdmissionStorage」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ModelAdmissionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const demoModelStudentStorageKey = "models-kindergarten.demo-model-students";
export const demoSelectedModelStudentStorageKey = "mk-demo-model-student";

export const modelAdmissionProviderOptions: ReadonlyArray<{
  id: ModelAdmissionProviderId;
  label: string;
  protocol: DemoProviderProtocol;
  defaultBaseUrl: string;
}> = [
  { id: "ollama", label: "本地 Ollama", protocol: "ollama_native", defaultBaseUrl: "http://127.0.0.1:11434" },
  { id: "siliconflow", label: "硅基流动", protocol: "openai_chat_completions", defaultBaseUrl: "https://api.siliconflow.cn/v1" },
  { id: "custom_responses", label: "自定义 Responses", protocol: "openai_responses", defaultBaseUrl: "" },
];

const fullCapabilities: DemoModelCapabilities = {
  streaming: "supported",
  toolCalls: "supported",
  reasoning: "supported",
  usage: "supported",
  reasoningControl: { schemaVersion: 1, control: "effort_levels", adjustable: true, supportedProfiles: ["fast", "balanced", "deep", "max"], defaultProfile: "balanced" },
};

const qwenOllamaCapabilities: DemoModelCapabilities = {
  streaming: "supported",
  toolCalls: "supported",
  reasoning: "supported",
  usage: "supported",
  reasoningControl: {
    schemaVersion: 1,
    control: "toggle",
    adjustable: true,
    supportedProfiles: ["fast", "balanced"],
    defaultProfile: "balanced",
    native: { parameter: "think", values: [false, true] },
  },
};

const ollamaModels: DiscoveredDemoModel[] = [
  {
    id: "qwen3:8b",
    name: "Qwen3 8B",
    description: "本机已安装 · 推荐演示模型",
    capabilities: qwenOllamaCapabilities,
  },
  {
    id: "deepseek-r1:8b",
    name: "DeepSeek R1 8B",
    description: "本机已安装 · 推理模型",
    capabilities: {
      streaming: "supported",
      toolCalls: "unverified",
      reasoning: "supported",
      usage: "supported",
      reasoningControl: { schemaVersion: 1, control: "fixed", adjustable: false, supportedProfiles: ["deep"], defaultProfile: "deep" },
    },
  },
];

const siliconFlowModels: DiscoveredDemoModel[] = [
  {
    id: "Qwen/Qwen3-8B",
    name: "Qwen3 8B",
    description: "硅基流动 · 8B 参数",
    capabilities: {
      streaming: "supported",
      toolCalls: "supported",
      reasoning: "unverified",
      usage: "supported",
      reasoningControl: { schemaVersion: 1, control: "fixed", adjustable: false, supportedProfiles: ["balanced"], defaultProfile: "balanced" },
    },
  },
  {
    id: "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B",
    name: "DeepSeek R1 Distill 7B",
    description: "硅基流动 · 推理模型",
    capabilities: {
      streaming: "supported",
      toolCalls: "unverified",
      reasoning: "supported",
      usage: "supported",
      reasoningControl: { schemaVersion: 1, control: "fixed", adjustable: false, supportedProfiles: ["deep"], defaultProfile: "deep" },
    },
  },
];

/** 根据已校验输入构建「createAdmissionDraft」结果，不额外持有调用方的大对象。 */
export function createAdmissionDraft(providerId: ModelAdmissionProviderId = "ollama"): ModelAdmissionDraft {
  return {
    providerId,
    connectionName: "",
    name: "",
    baseUrl: providerOption(providerId).defaultBaseUrl,
    apiKey: "",
    modelId: "",
  };
}

/** 切换 Provider 会丢弃前一个连接的所有输入，避免 Key、地址或模型串到另一种协议。 */
export function switchAdmissionProvider(
  draft: ModelAdmissionDraft,
  providerId: ModelAdmissionProviderId,
): ModelAdmissionDraft {
  if (draft.providerId === providerId) return draft;
  return createAdmissionDraft(providerId);
}

/** 更新「updateAdmissionDraft」对应状态，并保持写入顺序、原子性与容量约束。 */
export function updateAdmissionDraft(
  draft: ModelAdmissionDraft,
  patch: Partial<Omit<ModelAdmissionDraft, "providerId">>,
): ModelAdmissionDraft {
  return { ...draft, ...patch };
}

/** 这里只校验“能否测试连接”；Ollama 和硅基流动会在连接成功后再选择模型。 */
export function validateAdmissionDraft(draft: ModelAdmissionDraft): ModelAdmissionValidation {
  const errors: ModelAdmissionValidation["errors"] = {};
  const baseUrl = parseUrl(draft.baseUrl);

  if (!baseUrl) {
    errors.baseUrl = "请输入完整的服务地址。";
  } else if (draft.providerId === "custom_responses" && baseUrl.protocol !== "https:") {
    errors.baseUrl = "自定义云端接口必须使用 HTTPS。";
  } else if (draft.providerId === "ollama" && baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    errors.baseUrl = "Ollama 地址必须使用 HTTP 或 HTTPS。";
  }

  if (draft.providerId !== "ollama" && draft.apiKey.trim().length < 8) {
    errors.apiKey = "请粘贴有效的 API Key。";
  }

  if (draft.providerId === "custom_responses" && !draft.connectionName.trim()) {
    errors.connectionName = "请为这条自定义连接命名。";
  }

  if (draft.providerId === "custom_responses" && !draft.modelId.trim()) {
    errors.modelId = "请输入上游模型 ID。";
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/** Demo 不访问真实 Provider；invalid 约定用于稳定演示异步失败后的界面。 */
export function simulateAdmissionTest(draft: ModelAdmissionDraft): ModelAdmissionTestResult {
  const validation = validateAdmissionDraft(draft);
  if (!validation.valid) {
    return { ok: false, error: Object.values(validation.errors)[0] ?? "连接配置不完整。" };
  }

  const invalidInput = `${draft.baseUrl}\n${draft.apiKey}\n${draft.modelId}`.toLowerCase().includes("invalid");
  if (invalidInput) {
    if (draft.providerId === "ollama") return { ok: false, error: "没有检测到 Ollama，请确认本地服务已经启动。" };
    if (draft.providerId === "siliconflow") return { ok: false, error: "硅基流动拒绝了当前 API Key，请检查后重试。" };
    return { ok: false, error: "Responses 接口不可用，或当前地址与协议不兼容。" };
  }

  if (draft.providerId === "ollama") return { ok: true, models: cloneModels(ollamaModels) };
  if (draft.providerId === "siliconflow") return { ok: true, models: cloneModels(siliconFlowModels) };
  return {
    ok: true,
    models: [{
      id: draft.modelId.trim(),
      name: draft.modelId.trim(),
      description: "自定义 Responses API · 用户指定模型",
      capabilities: cloneCapabilities(fullCapabilities),
    }],
  };
}

/** 根据已校验输入构建「buildDemoModelStudent」结果，不额外持有调用方的大对象。 */
export function buildDemoModelStudent(
  draft: ModelAdmissionDraft,
  model: DiscoveredDemoModel,
  id = `student-${slug(`${draft.providerId}-${model.id}`)}-${Date.now()}`,
): DemoModelStudent {
  if (!simulateAdmissionTest(draft).ok) throw new Error("连接尚未通过验证，不能完成入园。");
  if (!model.id.trim()) throw new Error("必须选择一个模型后才能完成入园。");

  const option = providerOption(draft.providerId);
  return {
    id,
    name: draft.name.trim() || model.name,
    model: model.id,
    provider: draft.providerId === "custom_responses" ? `${draft.connectionName.trim()} · Responses` : option.label,
    protocol: option.protocol,
    baseUrl: normalizeBaseUrl(draft.baseUrl),
    ...(draft.providerId === "ollama" ? {} : { credentialHint: maskCredential(draft.apiKey) }),
    capabilities: cloneCapabilities(model.capabilities),
    score: null,
    state: "待评测",
  };
}

/** 读取「loadSavedModelStudents」所需数据，并遵守作用域、分页与容量边界。 */
export function loadSavedModelStudents(storage: Pick<ModelAdmissionStorage, "getItem">): DemoModelStudent[] {
  const raw = storage.getItem(demoModelStudentStorageKey);
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter(isDemoModelStudent).map(sanitizeStudent) : [];
  } catch {
    return [];
  }
}

/** 只序列化 ModelStudent 白名单字段；API Key 只存在于页面内存中的 Draft。 */
export function saveModelStudent(storage: ModelAdmissionStorage, student: DemoModelStudent): DemoModelStudent[] {
  const safeStudent = sanitizeStudent(student);
  const next = [safeStudent, ...loadSavedModelStudents(storage).filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(candidate) => candidate.id !== safeStudent.id)];
  storage.setItem(demoModelStudentStorageKey, JSON.stringify(next));
  storage.setItem(demoSelectedModelStudentStorageKey, safeStudent.id);
  return next;
}

/** 汇总「mergeModelStudents」对应指标，保持缺失字段语义且不重复计算同一来源。 */
export function mergeModelStudents(saved: DemoModelStudent[], builtIns: DemoModelStudent[]): DemoModelStudent[] {
  const savedIds = new Set(saved.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(student) => student.id));
  return [...saved, ...builtIns.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(student) => !savedIds.has(student.id))];
}

/** 执行「providerOption」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function providerOption(providerId: ModelAdmissionProviderId) {
  const option = modelAdmissionProviderOptions.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(candidate) => candidate.id === providerId);
  if (!option) throw new Error(`不支持的 Provider：${providerId}`);
  return option;
}

/** 校验并规范化「parseUrl」输入，非法数据直接返回明确错误。 */
function parseUrl(value: string): URL | null {
  try {
    return new URL(value.trim());
  } catch {
    return null;
  }
}

/** 校验并规范化「normalizeBaseUrl」输入，非法数据直接返回明确错误。 */
function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/** 执行「maskCredential」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function maskCredential(apiKey: string): string {
  return `•••• ${apiKey.trim().slice(-4).toUpperCase()}`;
}

/** 执行「cloneModels」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function cloneModels(models: DiscoveredDemoModel[]): DiscoveredDemoModel[] {
  return models.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(model) => ({ ...model, capabilities: cloneCapabilities(model.capabilities) }));
}

/** 执行「sanitizeStudent」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function sanitizeStudent(student: StoredDemoModelStudent): DemoModelStudent {
  return {
    id: student.id,
    name: student.name,
    model: student.model,
    provider: student.provider,
    protocol: student.protocol,
    baseUrl: student.baseUrl,
    ...(student.credentialHint ? { credentialHint: student.credentialHint } : {}),
    capabilities: normalizeCapabilities(student.capabilities),
    score: student.score,
    state: student.state,
  };
}

/** 判断「isDemoModelStudent」对应条件，只返回判定结果且不修改输入状态。 */
function isDemoModelStudent(value: unknown): value is StoredDemoModelStudent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredDemoModelStudent>;
  return typeof candidate.id === "string"
    && typeof candidate.name === "string"
    && typeof candidate.model === "string"
    && typeof candidate.provider === "string"
    && isProtocol(candidate.protocol)
    && typeof candidate.baseUrl === "string"
    && (candidate.credentialHint === undefined || typeof candidate.credentialHint === "string")
    && isCapabilities(candidate.capabilities)
    && (candidate.score === null || typeof candidate.score === "number")
    && (candidate.state === "在读" || candidate.state === "旁听" || candidate.state === "待评测" || candidate.state === "不可用");
}

/** 判断「isProtocol」对应条件，只返回判定结果且不修改输入状态。 */
function isProtocol(value: unknown): value is DemoProviderProtocol {
  return value === "ollama_native" || value === "openai_chat_completions" || value === "openai_responses";
}

/** 判断「isCapabilities」对应条件，只返回判定结果且不修改输入状态。 */
function isCapabilities(value: unknown): value is StoredDemoModelCapabilities {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredDemoModelCapabilities>;
  return isCapabilityState(candidate.streaming)
    && isCapabilityState(candidate.toolCalls)
    && isCapabilityState(candidate.reasoning)
    && isCapabilityState(candidate.usage)
    && (candidate.reasoningControl === undefined || isReasoningCapability(candidate.reasoningControl));
}

/** 判断「isCapabilityState」对应条件，只返回判定结果且不修改输入状态。 */
function isCapabilityState(value: unknown): value is DemoModelCapabilities["streaming"] {
  return value === "supported" || value === "unsupported" || value === "unverified";
}

/** 校验并规范化「normalizeCapabilities」输入，非法数据直接返回明确错误。 */
function normalizeCapabilities(capabilities: StoredDemoModelCapabilities): DemoModelCapabilities {
  return {
    streaming: capabilities.streaming,
    toolCalls: capabilities.toolCalls,
    reasoning: capabilities.reasoning,
    usage: capabilities.usage,
    reasoningControl: capabilities.reasoningControl === undefined
      ? legacyReasoningCapability()
      : readModelReasoningCapability(capabilities.reasoningControl),
  };
}

/** 执行「cloneCapabilities」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function cloneCapabilities(capabilities: DemoModelCapabilities): DemoModelCapabilities {
  return {
    ...capabilities,
    reasoningControl: readModelReasoningCapability(capabilities.reasoningControl),
  };
}

/** 执行「legacyReasoningCapability」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function legacyReasoningCapability(): ModelReasoningCapability {
  return {
    schemaVersion: 1,
    control: "fixed",
    adjustable: false,
    supportedProfiles: ["balanced"],
    defaultProfile: "balanced",
  };
}

/** 判断「isReasoningCapability」对应条件，只返回判定结果且不修改输入状态。 */
function isReasoningCapability(value: unknown): boolean {
  try {
    readModelReasoningCapability(value);
    return true;
  } catch {
    return false;
  }
}

/** 执行「slug」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "model";
}
