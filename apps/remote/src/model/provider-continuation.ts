import type { ModelStudent } from "./model-provider.js";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface ProviderContinuationCorrelation {
  /** 可见 assistant message/thought 的 Session messageId；用于避免重复投喂投影。 */
  messageIds: string[];
  /** Provider continuation 已包含的 Tool Call；用于把后续 Tool Result 保持在同一原子组。 */
  toolCallIds: string[];
}

/**
 * Provider 私有的无状态续接事实。
 *
 * Session / Context / Runtime 只允许读取身份、payloadByteLength 和 correlation；
 * payload 的结构与 format 只能由声明该 protocol 的 Provider Adapter 解释。
 */
export interface ProviderOpaqueContinuation {
  schemaVersion: 2;
  modelStudentId: string;
  providerKind: string;
  protocol: string;
  model: string;
  format: string;
  payload: JsonValue;
  payloadByteLength: number;
  correlation: ProviderContinuationCorrelation;
}

export interface CreateProviderOpaqueContinuationInput {
  modelStudentId: string;
  providerKind: string;
  protocol: string;
  model: string;
  format: string;
  payload: JsonValue;
  correlation?: Partial<ProviderContinuationCorrelation>;
}

export interface LegacyResponsesContinuationMigration {
  modelStudentId: string;
  messageIds: string[];
  toolCallIds: string[];
}

export function createProviderOpaqueContinuation(
  input: CreateProviderOpaqueContinuationInput,
): ProviderOpaqueContinuation {
  const payload = cloneJsonValue(input.payload, "Provider continuation payload");
  return readV2({
    schemaVersion: 2,
    modelStudentId: input.modelStudentId,
    providerKind: input.providerKind,
    protocol: input.protocol,
    model: input.model,
    format: input.format,
    payload,
    payloadByteLength: jsonByteLength(payload),
    correlation: {
      messageIds: [...(input.correlation?.messageIds ?? [])],
      toolCallIds: [...(input.correlation?.toolCallIds ?? [])],
    },
  });
}

/**
 * 通用信封验证。旧 Responses v1 只在 Session Repository 提供明确迁移绑定时接受，
 * 防止任意运行时输入借“兼容”绕过 modelStudentId / protocol 绑定。
 */
export function readProviderOpaqueContinuation(
  value: unknown,
  legacyResponses?: LegacyResponsesContinuationMigration,
): ProviderOpaqueContinuation {
  if (!isRecord(value)) throw new Error("Provider continuation 必须是对象");
  if (value.schemaVersion === 2) return readV2(value);
  if (value.schemaVersion === 1 && legacyResponses) {
    return migrateLegacyResponsesV1(value, legacyResponses);
  }
  throw new Error("Provider continuation schemaVersion 无效");
}

/** 在 Session 投影边界补齐可见消息关联；不读取或重写 Provider payload。 */
export function withProviderContinuationCorrelation(
  continuation: ProviderOpaqueContinuation,
  correlation: Partial<ProviderContinuationCorrelation>,
): ProviderOpaqueContinuation {
  const current = readProviderOpaqueContinuation(continuation);
  return {
    ...current,
    correlation: {
      messageIds: uniqueIds([
        ...current.correlation.messageIds,
        ...(correlation.messageIds ?? []),
      ], "Provider continuation correlation.messageIds"),
      toolCallIds: uniqueIds([
        ...current.correlation.toolCallIds,
        ...(correlation.toolCallIds ?? []),
      ], "Provider continuation correlation.toolCallIds"),
    },
  };
}

export function assertContinuationTargetsStudent(
  continuation: ProviderOpaqueContinuation,
  student: ModelStudent,
  protocol: string,
): void {
  if (
    continuation.modelStudentId !== student.id ||
    continuation.providerKind !== student.provider.kind ||
    continuation.protocol !== protocol ||
    continuation.model !== student.provider.model
  ) {
    throw new Error("Provider continuation 与当前 ModelStudent / protocol / model 不匹配");
  }
}

function readV2(value: Record<string, unknown>): ProviderOpaqueContinuation {
  const modelStudentId = nonEmptyString(value.modelStudentId, "modelStudentId");
  const providerKind = nonEmptyString(value.providerKind, "providerKind");
  const protocol = nonEmptyString(value.protocol, "protocol");
  const model = nonEmptyString(value.model, "model");
  const format = nonEmptyString(value.format, "format");
  const payload = cloneJsonValue(value.payload, "payload");
  const payloadByteLength = jsonByteLength(payload);
  const declaredPayloadByteLength = value.payloadByteLength;
  if (
    typeof declaredPayloadByteLength !== "number" ||
    !Number.isSafeInteger(declaredPayloadByteLength) ||
    declaredPayloadByteLength < 0 ||
    declaredPayloadByteLength !== payloadByteLength
  ) {
    throw new Error("Provider continuation payloadByteLength 无效");
  }
  if (!isRecord(value.correlation)) {
    throw new Error("Provider continuation correlation 无效");
  }
  return {
    schemaVersion: 2,
    modelStudentId,
    providerKind,
    protocol,
    model,
    format,
    payload,
    payloadByteLength,
    correlation: {
      messageIds: readIds(value.correlation.messageIds, "correlation.messageIds"),
      toolCallIds: readIds(value.correlation.toolCallIds, "correlation.toolCallIds"),
    },
  };
}

function migrateLegacyResponsesV1(
  value: Record<string, unknown>,
  migration: LegacyResponsesContinuationMigration,
): ProviderOpaqueContinuation {
  if (value.providerKind !== "openai-compatible") {
    throw new Error("旧 Responses continuation providerKind 无效");
  }
  const model = nonEmptyString(value.model, "model");
  if (value.format !== "openai-responses-output-v1") {
    throw new Error("旧 Responses continuation format 无效");
  }
  if (!Array.isArray(value.items) || !value.items.every(isJsonObject)) {
    throw new Error("旧 Responses continuation items 必须是 JSON 对象数组");
  }
  return createProviderOpaqueContinuation({
    modelStudentId: nonEmptyString(migration.modelStudentId, "modelStudentId"),
    providerKind: "openai-compatible",
    protocol: "openai_responses",
    model,
    format: "openai-responses-output-v1",
    payload: { items: value.items },
    correlation: {
      messageIds: readIds(migration.messageIds, "legacy messageIds"),
      toolCallIds: readIds(migration.toolCallIds, "legacy toolCallIds"),
    },
  });
}

function cloneJsonValue(value: unknown, field: string): JsonValue {
  if (!isJsonValue(value)) throw new Error(`${field} 必须是 JSON-safe value`);
  return structuredClone(value);
}

function jsonByteLength(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function readIds(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Provider continuation ${field} 无效`);
  return uniqueIds(value, `Provider continuation ${field}`);
}

function uniqueIds(value: unknown[], field: string): string[] {
  if (!value.every((item) => typeof item === "string" && item.length > 0)) {
    throw new Error(`${field} 必须是非空字符串数组`);
  }
  return [...new Set(value as string[])];
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Provider continuation ${field} 无效`);
  }
  return value;
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
