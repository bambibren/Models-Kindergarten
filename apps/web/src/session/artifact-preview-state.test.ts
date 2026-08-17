import type { FileReference } from "@kindergarten/contracts";
import { describe, expect, it } from "vitest";
import type { EntryCollection, ToolCallEntry } from "../chat/chat-types.js";
import {
  activeArtifactPreview,
  artifactPreviewReducer,
  closedArtifactPreview,
  collectFileReferenceIds,
  fileReferenceIdsAfter,
} from "./artifact-preview-state.js";

describe("artifact preview state", () => {
  it("closed 状态收到文件更新仍保持关闭，只由 preview/open 打开", () => {
    const updated = artifactPreviewReducer(closedArtifactPreview, {
      type: "references/resolved",
      expectedFileReferenceId: "file_old_reference",
      files: [file("file_new_reference", "session-a", "index.html")],
    });

    expect(updated).toEqual({ phase: "closed" });
    expect(artifactPreviewReducer(updated, {
      type: "preview/open",
      sessionId: "session-a",
      fileReferenceId: "file_old_reference",
    })).toEqual({
      phase: "open",
      sessionId: "session-a",
      fileReferenceId: "file_old_reference",
    });
  });

  it("会话变化时关闭旧会话预览，渲染层也不暴露跨会话状态", () => {
    const selected = artifactPreviewReducer(closedArtifactPreview, {
      type: "preview/open",
      sessionId: "session-a",
      fileReferenceId: "file_old_reference",
    });

    expect(activeArtifactPreview(selected, "session-b")).toBeNull();
    expect(artifactPreviewReducer(selected, { type: "session/change", sessionId: "session-b" }))
      .toEqual({ phase: "closed" });
  });

  it("只接受当前选择对应的文件元数据", () => {
    const selected = artifactPreviewReducer(closedArtifactPreview, {
      type: "preview/open",
      sessionId: "session-a",
      fileReferenceId: "file_old_reference",
    });

    expect(artifactPreviewReducer(selected, {
      type: "file/loaded",
      file: file("file_other_reference", "session-a", "index.html"),
    })).toBe(selected);
    expect(artifactPreviewReducer(selected, {
      type: "file/loaded",
      file: file("file_old_reference", "session-b", "index.html"),
    })).toBe(selected);
    expect(artifactPreviewReducer(selected, {
      type: "file/loaded",
      file: file("file_old_reference", "session-a", "index.html"),
    })).toMatchObject({ file: { relativePath: "index.html" } });
  });

  it("当前路径产生新引用时跟随最后一个版本，不跟随同名或其他会话文件", () => {
    const old = file("file_old_reference", "session-a", "pages/index.html");
    const opened = artifactPreviewReducer(closedArtifactPreview, {
      type: "preview/open",
      sessionId: "session-a",
      fileReferenceId: old.fileReferenceId,
    });
    const selected = artifactPreviewReducer(opened, { type: "file/loaded", file: old });
    const result = artifactPreviewReducer(selected, {
      type: "references/resolved",
      expectedFileReferenceId: old.fileReferenceId,
      files: [
        file("file_same_name", "session-a", "other/index.html"),
        file("file_other_session", "session-b", "pages/index.html"),
        file("file_new_reference", "session-a", "pages/index.html"),
        file("file_latest_reference", "session-a", "pages/index.html"),
      ],
    });

    expect(result).toMatchObject({
      phase: "open",
      sessionId: "session-a",
      fileReferenceId: "file_latest_reference",
      file: { relativePath: "pages/index.html" },
    });
  });

  it("预览已打开但更新属于其他路径时保持当前版本", () => {
    const old = file("file_old_reference", "session-a", "pages/index.html");
    const opened = artifactPreviewReducer(closedArtifactPreview, {
      type: "preview/open",
      sessionId: "session-a",
      fileReferenceId: old.fileReferenceId,
    });
    const selected = artifactPreviewReducer(opened, { type: "file/loaded", file: old });

    expect(artifactPreviewReducer(selected, {
      type: "references/resolved",
      expectedFileReferenceId: old.fileReferenceId,
      files: [file("file_other_reference", "session-a", "pages/detail.html")],
    })).toBe(selected);
  });

  it("从已归约的聊天条目按出现顺序收集文件引用，并只返回当前引用之后的版本", () => {
    const history = collection(tool("tool-old", "file_old_reference"));
    const streaming = collection(
      tool("tool-other", "file_other_reference"),
      tool("tool-latest", "file_latest_reference"),
      tool("tool-duplicate", "file_latest_reference"),
    );

    const ids = collectFileReferenceIds(history, streaming);

    expect(ids).toEqual(["file_old_reference", "file_other_reference", "file_latest_reference"]);
    expect(fileReferenceIdsAfter(ids, "file_old_reference")).toEqual([
      "file_other_reference",
      "file_latest_reference",
    ]);
    expect(fileReferenceIdsAfter(ids, "file_missing_reference")).toEqual([]);
  });
});

function file(fileReferenceId: string, sessionId: string, relativePath: string): FileReference {
  return {
    schemaVersion: 1,
    fileReferenceId,
    ownerId: "local-admin",
    sessionId,
    turnId: "turn-1",
    displayName: relativePath.split("/").at(-1) ?? relativePath,
    relativePath,
    mimeType: "text/html",
    byteLength: 12,
    sha256: "a".repeat(64),
    previewKind: "static_html",
    createdAt: "2026-08-17T00:00:00.000Z",
  };
}

function tool(id: string, fileReferenceId: string): ToolCallEntry {
  return {
    id: `tool:${id}`,
    type: "tool_call",
    turnId: "turn-1",
    toolCallId: id,
    title: "写入文件",
    name: "write_file",
    kind: "edit",
    status: "completed",
    content: [{
      type: "content",
      content: {
        type: "resource_link",
        name: "index.html",
        uri: `mk-file://${fileReferenceId}`,
      },
    }],
    locations: [],
  };
}

function collection(...entries: ToolCallEntry[]): EntryCollection {
  return {
    order: entries.map((entry) => entry.id),
    byId: Object.fromEntries(entries.map((entry) => [entry.id, entry])),
  };
}
