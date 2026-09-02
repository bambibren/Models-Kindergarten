import { describe, expect, it } from "vitest";
import {
  activePublishedArtifactId,
  closedPublishedArtifactPreview,
  publishedArtifactPreviewReducer,
} from "./published-artifact-preview-state.js";

describe("published artifact preview state", () => {
  it("切换 Session 时立即隐藏并清空旧 Session 的产物预览", () => {
    const opened = publishedArtifactPreviewReducer(closedPublishedArtifactPreview, {
      type: "preview/open",
      sessionId: "session-a",
      artifactId: "artifact-a",
    });

    expect(activePublishedArtifactId(opened, "session-b")).toBeNull();
    expect(publishedArtifactPreviewReducer(opened, {
      type: "session/change",
      sessionId: "session-b",
    })).toEqual({ phase: "closed" });
  });

  it("当前 Session 未变化时保留预览，显式关闭时清空", () => {
    const opened = publishedArtifactPreviewReducer(closedPublishedArtifactPreview, {
      type: "preview/open",
      sessionId: "session-a",
      artifactId: "artifact-a",
    });

    expect(publishedArtifactPreviewReducer(opened, {
      type: "session/change",
      sessionId: "session-a",
    })).toBe(opened);
    expect(activePublishedArtifactId(opened, "session-a")).toBe("artifact-a");
    expect(publishedArtifactPreviewReducer(opened, { type: "preview/close" }))
      .toEqual({ phase: "closed" });
  });
});
