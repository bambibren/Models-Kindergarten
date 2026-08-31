import { isRecord } from "./common.js";
import {
  parseConcreteReasoningProfile,
  readModelReasoningCapability,
  type ConcreteReasoningProfile,
  type ModelReasoningCapability,
} from "./reasoning.js";
import type { ModelStudentSummary } from "./control-api.js";

/** 描述「ProviderProtocol」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ProviderProtocol =
  | "ollama_native"
  | "openai_responses"
  | "openai_chat_completions"
  | "anthropic_messages";

/** 描述「ReadyModelProviderPresetId」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ReadyModelProviderPresetId = "ollama" | "openai" | "custom_responses" | "siliconflow";
/** 描述「ModelProviderPresetId」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ModelProviderPresetId = ReadyModelProviderPresetId | "anthropic";
/** 描述「ModelStudentTestState」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ModelStudentTestState = "testing" | "succeeded" | "failed" | "expired";

/** 描述「ModelProviderPresetView」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ModelProviderPresetView {
  schemaVersion: 1;
  presetId: ModelProviderPresetId;
  displayName: string;
  description: string;
  protocol: ProviderProtocol;
  availability: "ready" | "planned";
  baseUrl:
    | { mode: "fixed"; value: string }
    | { mode: "editable"; defaultValue?: string };
  auth: {
    scheme: "none" | "bearer" | "api_key_header";
    apiKeyLabel: string;
  };
  modelEntry: "manual" | "discoverable";
}

interface CandidateCommon {
  displayName: string;
  model: string;
}

/** 浏览器输入合同。固定预设刻意没有 baseUrl，避免客户端把流量改送到任意地址。 */
export type ModelStudentCandidateInput =
  | (CandidateCommon & { presetId: "ollama"; baseUrl: string })
  | (CandidateCommon & { presetId: "openai"; apiKey: string })
  | (CandidateCommon & { presetId: "siliconflow"; apiKey: string })
  | (CandidateCommon & { presetId: "custom_responses"; baseUrl: string; apiKey: string });

/** Remote 解析预设后的瞬时配置；只存在于一次请求及有 TTL 的内存中。 */
export interface ResolvedModelStudentCandidate extends CandidateCommon {
  presetId: ReadyModelProviderPresetId;
  protocol: Exclude<ProviderProtocol, "anthropic_messages">;
  baseUrl: string;
  apiKey?: string;
}

/** 兼容既有 Responses Prober 的内部输入。新控制面应使用 ModelStudentCandidateInput。 */
export interface ResponsesModelCandidateInput extends CandidateCommon {
  baseUrl: string;
  apiKey: string;
}

/** 可持久化、可返回浏览器的候选摘要；严禁加入 Secret 引用或明文。 */
export interface ModelStudentCandidatePublic {
  presetId: ReadyModelProviderPresetId;
  displayName: string;
  baseUrl: string;
  model: string;
  protocol: Exclude<ProviderProtocol, "anthropic_messages">;
}

/** 旧名称只作为源码兼容别名；持久化读取会补齐 custom_responses。 */
export type ResponsesModelCandidatePublic = ModelStudentCandidatePublic;

/** 描述「NativeReasoningValue」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type NativeReasoningValue = string | number | boolean;
/** 描述「NativeReasoningParameters」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type NativeReasoningParameters = Record<string, NativeReasoningValue>;

/** 描述「ProviderReasoningProbe」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ProviderReasoningProbe {
  capability: ModelReasoningCapability;
  /** 按产品档位保存精确原生参数；不能通过模型名称或供应商域名推断。 */
  nativeByProfile: Partial<Record<ConcreteReasoningProfile, NativeReasoningParameters>>;
  /** 体检实际确认的原生参数组合，供只读诊断展示。 */
  acceptedNativeValues: NativeReasoningParameters[];
}

/** 描述「ProviderCapabilitySnapshot」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ProviderCapabilitySnapshot {
  schemaVersion: 1;
  protocol: Exclude<ProviderProtocol, "anthropic_messages">;
  adapterRevision: string;
  probeVersion: number;
  /** preset + protocol + endpoint + model 的非 Secret SHA-256。 */
  connectionFingerprint: string;
  streaming: boolean;
  text: boolean;
  toolCalls: boolean;
  toolContinuation: boolean;
  usage: boolean;
  thought: boolean;
  reasoning: ProviderReasoningProbe;
  testedAt: string;
}

/** 只用于兼容旧 Responses v1 持久化记录；新公开快照不包含这些字段。 */
interface LegacyResponsesReasoningProbe {
  capability: ModelReasoningCapability;
  efforts: Partial<Record<ConcreteReasoningProfile, string>>;
  acceptedEfforts: string[];
}

/** 描述「ResponsesCapabilityProbe」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ResponsesCapabilityProbe = ProviderCapabilitySnapshot & { protocol: "openai_responses" };

/** 描述「ModelStudentTestRecord」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ModelStudentTestRecord {
  schemaVersion: 1;
  testId: string;
  ownerId: string;
  candidate: ModelStudentCandidatePublic;
  state: ModelStudentTestState;
  snapshot?: ProviderCapabilitySnapshot;
  error?: { code: string; message: string; retryable: boolean };
  createdAt: string;
  expiresAt: string;
}

/** 描述「ModelStudentInstallInput」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ModelStudentInstallInput {
  testId: string;
  displayName?: string;
  defaultReasoningProfile?: ConcreteReasoningProfile;
  contextWindowTokens?: number;
}

/** Connection 是内部复用实体；这个 View 只能表达安全状态，不能回读 credentialRef。 */
export interface ProviderConnectionView {
  schemaVersion: 1;
  connectionId: string;
  ownerId: string;
  presetId: ReadyModelProviderPresetId;
  protocol: Exclude<ProviderProtocol, "anthropic_messages">;
  baseUrl: string;
  credentialConfigured: boolean;
  credentialHint?: string;
  createdAt: string;
  updatedAt: string;
}

/** 已入园模型可安全返回浏览器的完整只读详情；不包含 Secret 引用或明文凭据。 */
export interface ModelStudentDetailView extends ModelStudentSummary {
  admission: {
    schemaVersion: 1;
    presetId: ReadyModelProviderPresetId;
    protocol: Exclude<ProviderProtocol, "anthropic_messages">;
    baseUrl: string;
    credentialConfigured: boolean;
    credentialHint?: string;
    defaultReasoningProfile: ConcreteReasoningProfile;
    snapshot: ProviderCapabilitySnapshot;
    createdAt: string;
    updatedAt: string;
  };
}

/** 校验并规范化「parseModelStudentCandidateInput」输入，非法数据直接返回明确错误。 */
export function parseModelStudentCandidateInput(value: unknown): ModelStudentCandidateInput {
  if (!isRecord(value)) throw new Error("模型连接配置必须是对象");

  // 只兼容已发布的 v1 自定义 Responses 请求；它仍经过相同 HTTPS 校验。
  const presetId = value.presetId === undefined && typeof value.baseUrl === "string"
    ? "custom_responses"
    : boundedString(value.presetId, "presetId", 1, 80);
  if (presetId !== "ollama" && presetId !== "openai" && presetId !== "custom_responses" && presetId !== "siliconflow") {
    throw new Error("presetId 当前只支持 ollama、openai、custom_responses 或 siliconflow");
  }

  const allowed = new Set([
    "presetId",
    "displayName",
    "model",
    ...(presetId === "ollama" ? ["baseUrl"] : ["apiKey"]),
    ...(presetId === "custom_responses" ? ["baseUrl"] : []),
  ]);
  const unknown = Object.keys(value).find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(key) => !allowed.has(key));
  if (unknown) throw new Error(`模型连接配置包含未知字段: ${unknown}`);
  const common = {
    displayName: boundedString(value.displayName, "displayName", 1, 80),
    model: boundedString(value.model, "model", 1, 200),
  };
  if (presetId === "ollama") {
    return {
      presetId,
      ...common,
      baseUrl: normalizeLocalOllamaBaseUrl(boundedString(value.baseUrl, "baseUrl", 1, 2_048)),
    };
  }
  const apiKey = boundedString(value.apiKey, "apiKey", 1, 8_192, false);
  if (presetId === "custom_responses") {
    return {
      presetId,
      ...common,
      apiKey,
      baseUrl: normalizeModelBaseUrl(boundedString(value.baseUrl, "baseUrl", 1, 2_048)),
    };
  }
  return { presetId, ...common, apiKey };
}

/** @deprecated 新代码使用 parseModelStudentCandidateInput。 */
/** 校验并规范化「parseResponsesModelCandidateInput」输入，非法数据直接返回明确错误。 */
export function parseResponsesModelCandidateInput(value: unknown): ResponsesModelCandidateInput {
  const parsed = parseModelStudentCandidateInput(value);
  if (parsed.presetId !== "custom_responses") {
    throw new Error("Responses 候选必须使用 custom_responses 预设");
  }
  return {
    displayName: parsed.displayName,
    baseUrl: parsed.baseUrl,
    model: parsed.model,
    apiKey: parsed.apiKey,
  };
}

/** 校验并规范化「parseModelStudentInstallInput」输入，非法数据直接返回明确错误。 */
export function parseModelStudentInstallInput(value: unknown): ModelStudentInstallInput {
  if (!isRecord(value)) throw new Error("模型入园请求必须是对象");
  const allowed = new Set(["testId", "displayName", "defaultReasoningProfile", "contextWindowTokens"]);
  const unknown = Object.keys(value).find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(key) => !allowed.has(key));
  if (unknown) throw new Error(`模型入园请求包含未知字段: ${unknown}`);
  const testId = boundedString(value.testId, "testId", 1, 200);
  const displayName = value.displayName === undefined
    ? undefined
    : boundedString(value.displayName, "displayName", 1, 80);
  const defaultReasoningProfile = value.defaultReasoningProfile === undefined
    ? undefined
    : parseConcreteReasoningProfile(value.defaultReasoningProfile, "defaultReasoningProfile");
  const contextWindowTokens = value.contextWindowTokens === undefined
    ? undefined
    : requiredPositiveInteger(value.contextWindowTokens, "contextWindowTokens");
  return {
    testId,
    ...(displayName ? { displayName } : {}),
    ...(defaultReasoningProfile ? { defaultReasoningProfile } : {}),
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
  };
}

/** 读取「readProviderCapabilitySnapshot」所需数据，并遵守作用域、分页与容量边界。 */
export function readProviderCapabilitySnapshot(value: unknown): ProviderCapabilitySnapshot {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("Provider capability snapshot 格式无效");
  }
  if (value.protocol === "openai_responses") return readResponsesCapabilityProbe(value);
  if (value.protocol === "ollama_native") return readGenericCapabilitySnapshot(value, "ollama_native");
  if (value.protocol !== "openai_chat_completions") {
    throw new Error("Provider capability snapshot.protocol 格式无效");
  }
  return readGenericCapabilitySnapshot(value, "openai_chat_completions");
}

/** 读取「readResponsesCapabilityProbe」所需数据，并遵守作用域、分页与容量边界。 */
export function readResponsesCapabilityProbe(value: unknown): ResponsesCapabilityProbe {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.protocol !== "openai_responses") {
    throw new Error("Responses capability probe 格式无效");
  }
  const common = readCapabilityCommon(value, "Responses");
  if (!isRecord(value.reasoning)) throw new Error("Responses reasoning probe 格式无效");
  const capability = readModelReasoningCapability(value.reasoning.capability);
  const legacy = value.reasoning.nativeByProfile === undefined || value.reasoning.acceptedNativeValues === undefined
    ? readLegacyResponsesReasoning(value.reasoning, capability)
    : undefined;
  const nativeByProfile = value.reasoning.nativeByProfile === undefined
    ? legacy!.nativeByProfile
    : readNativeByProfile(value.reasoning.nativeByProfile, capability);
  const acceptedNativeValues = value.reasoning.acceptedNativeValues === undefined
    ? legacy!.acceptedNativeValues
    : readAcceptedNativeValues(value.reasoning.acceptedNativeValues);
  return {
    schemaVersion: 1,
    protocol: "openai_responses",
    adapterRevision: legacy
      ? optionalNonEmptyString(value.adapterRevision) ?? "openai-responses-legacy-v1"
      : requiredNonEmptyString(value.adapterRevision, "adapterRevision"),
    probeVersion: legacy
      ? positiveInteger(value.probeVersion) ?? 1
      : requiredPositiveInteger(value.probeVersion, "probeVersion"),
    connectionFingerprint: legacy
      ? optionalConnectionFingerprint(value.connectionFingerprint) ?? "legacy-unverified"
      : requiredConnectionFingerprint(value.connectionFingerprint),
    ...common,
    reasoning: {
      capability,
      nativeByProfile,
      acceptedNativeValues,
    },
  };
}

/** 校验并规范化「normalizeModelBaseUrl」输入，非法数据直接返回明确错误。 */
export function normalizeModelBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("baseUrl 必须是有效 URL"); }
  if (url.protocol !== "https:") throw new Error("baseUrl 必须使用 HTTPS");
  if (url.username || url.password) throw new Error("baseUrl 不能包含用户名或密码");
  if (url.search || url.hash) throw new Error("baseUrl 不能包含查询参数或片段");
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

/** Ollama 只允许当前 Remote 所在设备的回环地址，不能借可编辑 URL 探测局域网。 */
export function normalizeLocalOllamaBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("Ollama baseUrl 必须是有效 URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Ollama baseUrl 必须使用 HTTP 或 HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Ollama baseUrl 不能包含凭据、查询参数或片段");
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "[::1]" && hostname !== "::1") {
    throw new Error("Ollama baseUrl 只允许 localhost、127.0.0.1 或 ::1");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

/** @deprecated 新代码使用 normalizeModelBaseUrl。 */
export const normalizeResponsesBaseUrl = normalizeModelBaseUrl;

/** 读取「readGenericCapabilitySnapshot」所需数据，并遵守作用域、分页与容量边界。 */
function readGenericCapabilitySnapshot(
  value: Record<string, unknown>,
  protocol: "ollama_native" | "openai_chat_completions",
): ProviderCapabilitySnapshot {
  const common = readCapabilityCommon(value, "Provider");
  if (!isRecord(value.reasoning)) throw new Error("Provider reasoning probe 格式无效");
  const capability = readModelReasoningCapability(value.reasoning.capability);
  return {
    schemaVersion: 1,
    protocol,
    adapterRevision: requiredNonEmptyString(value.adapterRevision, "adapterRevision"),
    probeVersion: requiredPositiveInteger(value.probeVersion, "probeVersion"),
    connectionFingerprint: requiredConnectionFingerprint(value.connectionFingerprint),
    ...common,
    reasoning: {
      capability,
      nativeByProfile: readNativeByProfile(value.reasoning.nativeByProfile, capability),
      acceptedNativeValues: readAcceptedNativeValues(value.reasoning.acceptedNativeValues),
    },
  };
}

/** 读取「readLegacyResponsesReasoning」所需数据，并遵守作用域、分页与容量边界。 */
function readLegacyResponsesReasoning(
  value: Record<string, unknown>,
  capability: ModelReasoningCapability,
): { nativeByProfile: Partial<Record<ConcreteReasoningProfile, NativeReasoningParameters>>; acceptedNativeValues: NativeReasoningParameters[] } {
  if (value.efforts === undefined && value.acceptedEfforts === undefined) {
    throw new Error("Responses reasoning probe 缺少 nativeByProfile");
  }
  if (!isRecord(value.efforts) || !Array.isArray(value.acceptedEfforts)) {
    throw new Error("Responses legacy reasoning probe 格式无效");
  }
  const legacy: LegacyResponsesReasoningProbe = {
    capability,
    efforts: {},
    acceptedEfforts: [],
  };
  for (const profile of capability.supportedProfiles) {
    const effort = value.efforts[profile];
    if (typeof effort !== "string" || effort.length === 0) throw new Error(`Responses reasoning ${profile} 缺少 effort`);
    legacy.efforts[profile] = effort;
  }
  if (value.acceptedEfforts.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => typeof item !== "string" || item.length === 0)) {
    throw new Error("Responses acceptedEfforts 格式无效");
  }
  legacy.acceptedEfforts = [...new Set(value.acceptedEfforts as string[])];
  return {
    nativeByProfile: Object.fromEntries(
      Object.entries(legacy.efforts).map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
([profile, effort]) => [profile, { effort: effort! }]),
    ),
    acceptedNativeValues: legacy.acceptedEfforts.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(effort) => ({ effort })),
  };
}

/** 读取「readCapabilityCommon」所需数据，并遵守作用域、分页与容量边界。 */
function readCapabilityCommon(value: Record<string, unknown>, label: string) {
  const streaming = booleanField(value, "streaming", label);
  const text = booleanField(value, "text", label);
  const toolCalls = booleanField(value, "toolCalls", label);
  const toolContinuation = booleanField(value, "toolContinuation", label);
  const usage = booleanField(value, "usage", label);
  const thought = booleanField(value, "thought", label);
  if (typeof value.testedAt !== "string") throw new Error(`${label} capability snapshot.testedAt 格式无效`);
  return { streaming, text, toolCalls, toolContinuation, usage, thought, testedAt: value.testedAt };
}

/** 读取「readNativeByProfile」所需数据，并遵守作用域、分页与容量边界。 */
function readNativeByProfile(
  value: unknown,
  capability: ModelReasoningCapability,
): Partial<Record<ConcreteReasoningProfile, NativeReasoningParameters>> {
  if (!isRecord(value)) throw new Error("reasoning.nativeByProfile 格式无效");
  const result: Partial<Record<ConcreteReasoningProfile, NativeReasoningParameters>> = {};
  for (const profile of capability.supportedProfiles) {
    const raw = value[profile];
    if (!isRecord(raw)) throw new Error(`reasoning.nativeByProfile.${profile} 缺失`);
    const parameters: NativeReasoningParameters = {};
    for (const [key, item] of Object.entries(raw)) {
      if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
        throw new Error(`reasoning.nativeByProfile.${profile}.${key} 格式无效`);
      }
      parameters[key] = item;
    }
    result[profile] = parameters;
  }
  return result;
}

/** 读取「readAcceptedNativeValues」所需数据，并遵守作用域、分页与容量边界。 */
function readAcceptedNativeValues(value: unknown): NativeReasoningParameters[] {
  if (!Array.isArray(value)) throw new Error("reasoning.acceptedNativeValues 格式无效");
  return value.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(raw, index) => {
    if (!isRecord(raw)) throw new Error(`reasoning.acceptedNativeValues.${index} 格式无效`);
    const result: NativeReasoningParameters = {};
    for (const [key, item] of Object.entries(raw)) {
      if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
        throw new Error(`reasoning.acceptedNativeValues.${index}.${key} 格式无效`);
      }
      result[key] = item;
    }
    return result;
  });
}

/** 执行「optionalNonEmptyString」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** 校验并取得「requiredNonEmptyString」所需对象；缺失或归属不符时立即抛出明确错误。 */
function requiredNonEmptyString(value: unknown, field: string): string {
  const result = optionalNonEmptyString(value);
  if (!result) throw new Error(`${field} 必须是非空字符串`);
  return result;
}

/** 执行「positiveInteger」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

/** 校验并取得「requiredPositiveInteger」所需对象；缺失或归属不符时立即抛出明确错误。 */
function requiredPositiveInteger(value: unknown, field: string): number {
  const result = positiveInteger(value);
  if (result === undefined) throw new Error(`${field} 必须是正整数`);
  return result;
}

/** 执行「optionalConnectionFingerprint」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function optionalConnectionFingerprint(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

/** 校验并取得「requiredConnectionFingerprint」所需对象；缺失或归属不符时立即抛出明确错误。 */
function requiredConnectionFingerprint(value: unknown): string {
  const result = optionalConnectionFingerprint(value);
  if (!result) throw new Error("connectionFingerprint 必须是 SHA-256 十六进制字符串");
  return result;
}

/** 执行「boundedString」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function boundedString(
  value: unknown,
  field: string,
  min: number,
  max: number,
  trim = true,
): string {
  if (typeof value !== "string") throw new Error(`${field} 必须是字符串`);
  const result = trim ? value.trim() : value;
  if (result.length < min || result.length > max) throw new Error(`${field} 长度必须为 ${min} 到 ${max}`);
  return result;
}

/** 执行「booleanField」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function booleanField(value: Record<string, unknown>, field: string, label: string): boolean {
  const result = value[field];
  if (typeof result !== "boolean") throw new Error(`${label} capability snapshot.${field} 格式无效`);
  return result;
}
