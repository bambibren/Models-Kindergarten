const EVALUATION_ENTRIES_VISIBLE_FROM = Date.parse("2026-09-03T00:00:00+08:00");

/**
 * 兼容性判断：效果打分与上下文实验上线前创建的历史 Session 不展示对应入口。
 * 该判断只限定两个评测入口，不代表 Chat Session 整体是否兼容或可用。
 * 使用固定发布时间而不是“今天零点”，避免边界随日期推进后误伤已经开放的新 Session。
 */
export function sessionSupportsEvaluationEntries(createdAt: string): boolean {
  const created = Date.parse(createdAt);
  return Number.isFinite(created) && created >= EVALUATION_ENTRIES_VISIBLE_FROM;
}
