/** 发布沿用上一版的功能状态；旧清单缺少记录时要求显式决定，避免静默关闭已上线功能。 */
export function resolveContextExperiments(previous, { enable = false, disable = false } = {}) {
  if (enable && disable) throw new Error("上下文实验不能同时指定开启和关闭");
  if (enable) return true;
  if (disable) return false;
  if (typeof previous !== "boolean") {
    throw new Error("基础 manifest 未记录上下文实验状态；请显式指定 --enable-context-experiments 或 --disable-context-experiments");
  }
  return previous;
}
