export const SCHEMA_VERSION = 1 as const;
export const META_KEY = "modelKindergarten" as const;

/** 描述「PublicErrorCode」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type PublicErrorCode =
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "ORIGIN_NOT_ALLOWED"
  | "AUTHENTICATION_REQUIRED"
  | "SESSION_BINDING_INVALID"
  | "SESSION_BUSY"
  | "REMOTE_BUSY"
  | "CAPABILITY_REFERENCE_INVALID"
  | "CAPABILITY_STALE"
  | "SKILL_SOURCE_NOT_ALLOWED"
  | "SKILL_SOURCE_NOT_USER_PROVIDED"
  | "SKILL_SOURCE_URL_LIMIT_EXCEEDED"
  | "SKILL_SOURCE_NAME_CONFLICT"
  | "SKILL_VALIDATION_FAILED"
  | "SKILL_JOB_INTERRUPTED"
  | "MCP_URL_NOT_ALLOWED"
  | "MCP_AUTH_NOT_SUPPORTED"
  | "MCP_TEST_EXPIRED"
  | "MCP_CONNECTION_FAILED"
  | "MCP_NOT_AVAILABLE"
  | "MODEL_URL_NOT_ALLOWED"
  | "MODEL_CONNECTION_FAILED"
  | "MODEL_PROBE_EXPIRED"
  | "MODEL_IN_USE"
  | "EXPERIMENT_NOT_RUNNABLE"
  | "EXPERIMENT_READ_ONLY"
  | "EXPERIMENT_PREVIEW_UNAVAILABLE"
  | "EXPERIMENT_NO_EFFECTIVE_DIFFERENCE"
  | "EXPERIMENT_SOURCE_CHANGED"
  | "LEGACY_EXPERIMENT_READ_ONLY"
  | "EXECUTION_METRICS_UNAVAILABLE"
  | "SCORECARD_INCOMPLETE"
  | "WORKSHEET_NOT_READY"
  | "WORKSHEET_GENERATOR_UNAVAILABLE"
  | "WORKSHEET_GENERATION_FAILED"
  | "WORKSHEET_GENERATION_INVALID"
  | "TURN_SNAPSHOT_UNAVAILABLE"
  | "FILE_REFERENCE_FORBIDDEN"
  | "FILE_PREVIEW_NOT_SUPPORTED"
  | "ARTIFACT_FORBIDDEN"
  | "ARTIFACT_VALIDATION_FAILED"
  | "ARTIFACT_RESOURCE_LIMIT"
  | "ARTIFACT_RESOURCE_NOT_FOUND"
  | "ARTIFACT_BLOB_CORRUPT"
  | "INTERNAL_ERROR";

/** 描述「PublicErrorRef」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface PublicErrorRef {
  code: PublicErrorCode;
  message: string;
  requestId?: string;
  retryable: boolean;
}

/** 描述「ApiSuccess」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ApiSuccess<T> {
  data: T;
  requestId: string;
}

/** 描述「CursorPage」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface CursorPage<T> {
  items: T[];
  nextCursor?: string;
}

/** 描述「ApiProblem」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ApiProblem {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: PublicErrorCode;
  requestId: string;
  retryable: boolean;
  fieldErrors?: Array<{ path: string; message: string }>;
}

/** 判断「isRecord」对应条件，只返回判定结果且不修改输入状态。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 校验并取得「requiredString」所需对象；缺失或归属不符时立即抛出明确错误。 */
export function requiredString(
  record: Record<string, unknown>,
  key: string,
  options: { max?: number; allowEmpty?: boolean; preserveWhitespace?: boolean } = {},
): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`${key} 必须是字符串`);
  const normalized = value.trim();
  if (!options.allowEmpty && normalized.length === 0) throw new Error(`${key} 不能为空`);
  const result = options.preserveWhitespace ? value : normalized;
  if (options.max !== undefined && result.length > options.max) {
    throw new Error(`${key} 不能超过 ${options.max} 个字符`);
  }
  return result;
}

/** 执行「optionalString」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function optionalString(
  record: Record<string, unknown>,
  key: string,
  options: { max?: number } = {},
): string | undefined {
  if (record[key] === undefined) return undefined;
  const value = requiredString(record, key, {
    ...(options.max === undefined ? {} : { max: options.max }),
    allowEmpty: true,
  });
  return value.length > 0 ? value : undefined;
}

/** 执行「stableJson」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

/** 执行「sortJson」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(/** 执行「map」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
([left], [right]) => left.localeCompare(right))
      .map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
([key, item]) => [key, sortJson(item)]),
  );
}
