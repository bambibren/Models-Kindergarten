export const SCHEMA_VERSION = 1 as const;
export const META_KEY = "modelKindergarten" as const;

export type PublicErrorCode =
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "ORIGIN_NOT_ALLOWED"
  | "SESSION_BINDING_INVALID"
  | "SESSION_BUSY"
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
  | "SCORECARD_INCOMPLETE"
  | "WORKSHEET_NOT_READY"
  | "WORKSHEET_GENERATOR_UNAVAILABLE"
  | "WORKSHEET_GENERATION_FAILED"
  | "WORKSHEET_GENERATION_INVALID"
  | "TURN_SNAPSHOT_UNAVAILABLE"
  | "FILE_REFERENCE_FORBIDDEN"
  | "FILE_PREVIEW_NOT_SUPPORTED"
  | "INTERNAL_ERROR";

export interface PublicErrorRef {
  code: PublicErrorCode;
  message: string;
  requestId?: string;
  retryable: boolean;
}

export interface ApiSuccess<T> {
  data: T;
  requestId: string;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor?: string;
}

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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}
