import { META_KEY, isRecord } from "./common.js";

/** 描述「SessionResumeTextCursor」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface SessionResumeTextCursor {
  textLength: number;
  nextChunkIndex: number;
}

/**
 * resume 不重放整段历史，只用当前 Turn 的文本偏移补齐断线缺口。
 * Tool、上下文提要和用量是按稳定 ID 覆盖的快照，不需要进入游标。
 */
export interface SessionResumeMeta {
  schemaVersion: 1;
  turnId: string;
  messages: Record<string, SessionResumeTextCursor>;
  thoughts: Record<string, SessionResumeTextCursor>;
}

/** 根据已校验输入构建「makeSessionResumeMeta」结果，不额外持有调用方的大对象。 */
export function makeSessionResumeMeta(value: SessionResumeMeta): Record<string, unknown> {
  return { [META_KEY]: { sessionResume: structuredClone(value) } };
}

/** 读取「readSessionResumeMeta」所需数据，并遵守作用域、分页与容量边界。 */
export function readSessionResumeMeta(value: unknown): SessionResumeMeta | undefined {
  if (!isRecord(value)) return undefined;
  const root = value[META_KEY];
  if (!isRecord(root) || !isRecord(root.sessionResume)) return undefined;
  const resume = root.sessionResume;
  if (resume.schemaVersion !== 1 || typeof resume.turnId !== "string" || resume.turnId.length === 0) {
    return undefined;
  }
  const messages = readCursors(resume.messages);
  const thoughts = readCursors(resume.thoughts);
  if (!messages || !thoughts) return undefined;
  return { schemaVersion: 1, turnId: resume.turnId, messages, thoughts };
}

/** 读取「readCursors」所需数据，并遵守作用域、分页与容量边界。 */
function readCursors(value: unknown): Record<string, SessionResumeTextCursor> | undefined {
  if (!isRecord(value)) return undefined;
  const cursors: Record<string, SessionResumeTextCursor> = {};
  for (const [id, raw] of Object.entries(value)) {
    if (!id || !isRecord(raw) || !nonNegativeInteger(raw.textLength) || !nonNegativeInteger(raw.nextChunkIndex)) {
      return undefined;
    }
    cursors[id] = { textLength: raw.textLength, nextChunkIndex: raw.nextChunkIndex };
  }
  return cursors;
}

/** 执行「nonNegativeInteger」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}
