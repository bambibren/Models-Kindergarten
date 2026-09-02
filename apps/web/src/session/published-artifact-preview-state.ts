/** 已发布 Artifact 预览必须绑定打开它的 Session，禁止跨 Session 继续展示。 */
export type PublishedArtifactPreviewState =
  | { phase: "closed" }
  | { phase: "open"; sessionId: string; artifactId: string };

export type PublishedArtifactPreviewAction =
  | { type: "preview/open"; sessionId: string; artifactId: string }
  | { type: "preview/close" }
  | { type: "session/change"; sessionId: string | null };

export const closedPublishedArtifactPreview: PublishedArtifactPreviewState = { phase: "closed" };

/** 归约已发布 Artifact 预览状态；Session 变化时关闭旧 Session 的预览。 */
export function publishedArtifactPreviewReducer(
  state: PublishedArtifactPreviewState,
  action: PublishedArtifactPreviewAction,
): PublishedArtifactPreviewState {
  if (action.type === "preview/open") {
    return {
      phase: "open",
      sessionId: action.sessionId,
      artifactId: action.artifactId,
    };
  }
  if (action.type === "preview/close") return closedPublishedArtifactPreview;
  return state.phase === "open" && state.sessionId === action.sessionId
    ? state
    : closedPublishedArtifactPreview;
}

/** 只向渲染层暴露当前 Session 打开的 Artifact。 */
export function activePublishedArtifactId(
  state: PublishedArtifactPreviewState,
  sessionId: string | null,
): string | null {
  return state.phase === "open" && state.sessionId === sessionId ? state.artifactId : null;
}
