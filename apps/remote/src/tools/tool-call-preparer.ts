import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import type { ModelToolCall, ModelToolDefinition, ModelToolSchema } from "../model/model-provider.js";
import { canonicalJson, type PreparedToolCall, type ToolRegistryPort, type ToolSchemaValidationError } from "./tool-registry.js";

const ajv = new Ajv({ strict: false, allErrors: true, allowUnionTypes: true });
const validators = new WeakMap<object, ValidateFunction>();

/**
 * Provider 负责领域参数规范化；这里统一用实际暴露给模型的 JSON Schema 做最后校验。
 * 普通错误只解释 Schema，不猜测错误字段与正确字段之间的对应关系。
 */
export function prepareToolCall(
  registry: ToolRegistryPort,
  modelCall: ModelToolCall,
  fallbackId: string,
): PreparedToolCall {
  const prepared = prepareWithProvider(registry, modelCall, fallbackId);
  const definition = registry.definitions.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.function.name === modelCall.name);
  if (!definition) return prepared;
  const validationErrors = validateArguments(definition, modelCall.arguments);
  if (validationErrors === undefined || validationErrors.length === 0 || hasExactCorrection(prepared)) {
    return prepared;
  }
  const schema = structuredClone(definition.function.parameters);
  return {
    ...prepared,
    arguments: structuredClone(modelCall.arguments),
    dedupeKey: `invalid:${modelCall.name}:${canonicalJson(modelCall.arguments)}`,
    validationError: {
      message: validationErrors.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.message).join("；"),
      validationErrors,
      schemaCorrection: {
        message: schemaCorrectionMessage(schema),
        expectedSchema: schema,
      },
      instruction: "请删除所有未声明字段，仅按照 schema_correction.expected_schema 重新构造参数并重试一次。",
    },
  };
}

/** 执行「prepareWithProvider」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function prepareWithProvider(
  registry: ToolRegistryPort,
  modelCall: ModelToolCall,
  fallbackId: string,
): PreparedToolCall {
  try {
    return registry.prepare(modelCall, fallbackId);
  } catch (error) {
    return {
      id: modelCall.id ?? fallbackId,
      name: modelCall.name,
      title: `无效工具调用：${modelCall.name}`,
      kind: "other",
      arguments: structuredClone(modelCall.arguments),
      permission: "allow",
      locations: [],
      dedupeKey: `invalid:${modelCall.name}:${canonicalJson(modelCall.arguments)}`,
      retry: "none",
      validationError: errorText(error),
    };
  }
}

/** 校验并规范化「validateArguments」输入，非法数据直接返回明确错误。 */
function validateArguments(
  definition: ModelToolDefinition,
  argumentsValue: Record<string, unknown>,
): ToolSchemaValidationError[] | undefined {
  const schema = definition.function.parameters;
  let validator = validators.get(schema);
  if (!validator) {
    try {
      validator = ajv.compile(schema);
      validators.set(schema, validator);
    } catch {
      // 无效的第三方 Schema 由对应 Provider 报错，通用层不编造替代规则。
      return undefined;
    }
  }
  if (validator(argumentsValue)) return [];
  return (validator.errors ?? []).map(toValidationError);
}

/** 根据已校验输入构建「toValidationError」结果，不额外持有调用方的大对象。 */
function toValidationError(error: ErrorObject): ToolSchemaValidationError {
  const parameter = error.keyword === "required"
    ? stringParam(error.params, "missingProperty")
    : error.keyword === "additionalProperties"
      ? stringParam(error.params, "additionalProperty")
      : pointerParameter(error.instancePath);
  return {
    keyword: error.keyword,
    instancePath: error.instancePath || "/",
    ...(parameter ? { parameter } : {}),
    message: validationMessage(error, parameter),
  };
}

/** 执行「validationMessage」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function validationMessage(error: ErrorObject, parameter: string | undefined): string {
  if (error.keyword === "required" && parameter) return `缺少必填参数 ${parameter}`;
  if (error.keyword === "additionalProperties" && parameter) return `参数 ${parameter} 未在 Schema 中声明`;
  const location = parameter ?? (error.instancePath || "/");
  return `参数 ${location} ${error.message ?? "不符合 Schema"}`;
}

/** 执行「schemaCorrectionMessage」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function schemaCorrectionMessage(schema: ModelToolSchema): string {
  const allowed = Object.keys(schema.properties ?? {});
  const required = schema.required ?? [];
  const allowedText = allowed.length > 0 ? allowed.join("、") : "无命名字段";
  const requiredText = required.length > 0 ? required.join("、") : "无";
  return `该工具允许字段：${allowedText}；必填字段：${requiredText}${schema.additionalProperties === false ? "；其他字段必须删除" : ""}。`;
}

/** 判断「hasExactCorrection」对应条件，只返回判定结果且不修改输入状态。 */
function hasExactCorrection(call: PreparedToolCall): boolean {
  return typeof call.validationError === "object" && Boolean(call.validationError.argumentCorrection);
}

/** 执行「pointerParameter」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function pointerParameter(value: string): string | undefined {
  const part = value.split("/").filter(Boolean).at(-1);
  return part?.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** 执行「stringParam」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function stringParam(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

/** 把未知异常转换为「errorText」文本，避免错误序列化过程再次抛出。 */
function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
