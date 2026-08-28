export const SPLIT_PANE_MIN = 300;
export const SPLIT_PANE_DIVIDER = 9;
export const DEFAULT_CHAT_WIDTH = 350;

/** 执行「clampArtifactWidth」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function clampArtifactWidth(requested: number, containerWidth: number): number {
  if (containerWidth <= SPLIT_PANE_MIN * 2 + SPLIT_PANE_DIVIDER) return SPLIT_PANE_MIN;
  return Math.min(
    Math.max(requested, SPLIT_PANE_MIN),
    containerWidth - SPLIT_PANE_MIN - SPLIT_PANE_DIVIDER,
  );
}

/** 执行「defaultArtifactWidth」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function defaultArtifactWidth(containerWidth: number): number {
  return clampArtifactWidth(containerWidth - DEFAULT_CHAT_WIDTH - SPLIT_PANE_DIVIDER, containerWidth);
}
