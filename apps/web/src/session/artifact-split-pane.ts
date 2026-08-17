export const SPLIT_PANE_MIN = 300;
export const SPLIT_PANE_DIVIDER = 9;
export const DEFAULT_CHAT_WIDTH = 350;

export function clampArtifactWidth(requested: number, containerWidth: number): number {
  if (containerWidth <= SPLIT_PANE_MIN * 2 + SPLIT_PANE_DIVIDER) return SPLIT_PANE_MIN;
  return Math.min(
    Math.max(requested, SPLIT_PANE_MIN),
    containerWidth - SPLIT_PANE_MIN - SPLIT_PANE_DIVIDER,
  );
}

export function defaultArtifactWidth(containerWidth: number): number {
  return clampArtifactWidth(containerWidth - DEFAULT_CHAT_WIDTH - SPLIT_PANE_DIVIDER, containerWidth);
}
