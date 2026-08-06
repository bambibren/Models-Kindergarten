export const META_KEY = "modelKindergarten" as const;

/**
 * ACP v1 已原生提供 messageId，这个扩展只补足轮次和 Chunk 边界。
 * Runtime 状态、UI 状态和持久化结构都不能塞进 `_meta`。
 */
export interface MessageMeta {
  schemaVersion: 1;
  turnId: string;
  chunkIndex: number;
  final?: boolean;
}

export interface PromptMeta {
  schemaVersion: 1;
  turnId: string;
}

export interface KindergartenMeta {
  message?: MessageMeta;
  prompt?: PromptMeta;
}

export interface AcpMeta extends Record<string, unknown> {
  [META_KEY]: KindergartenMeta;
}

export function makeAcpMeta(message: MessageMeta): AcpMeta {
  return {
    [META_KEY]: { message },
  };
}

export function makePromptMeta(prompt: PromptMeta): AcpMeta {
  return {
    [META_KEY]: { prompt },
  };
}

export function readMessageMeta(value: unknown): MessageMeta | undefined {
  if (!isRecord(value)) return undefined;
  const root = value[META_KEY];
  if (!isRecord(root) || !isRecord(root.message)) return undefined;

  const meta = root.message;
  if (
    meta.schemaVersion !== 1 ||
    typeof meta.turnId !== "string" ||
    typeof meta.chunkIndex !== "number"
  ) {
    return undefined;
  }

  return {
    schemaVersion: 1,
    turnId: meta.turnId,
    chunkIndex: meta.chunkIndex,
    ...(typeof meta.final === "boolean" ? { final: meta.final } : {}),
  };
}

export function readPromptMeta(value: unknown): PromptMeta | undefined {
  if (!isRecord(value)) return undefined;
  const root = value[META_KEY];
  if (!isRecord(root) || !isRecord(root.prompt)) return undefined;

  const meta = root.prompt;
  if (
    meta.schemaVersion !== 1 ||
    typeof meta.turnId !== "string"
  ) {
    return undefined;
  }

  return {
    schemaVersion: 1,
    turnId: meta.turnId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
