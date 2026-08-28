import { parseFileReferenceUri, type FileReference } from "@kindergarten/contracts";
import type { ChatEntry, EntryCollection } from "../chat/chat-types.js";

/** 描述「ArtifactPreviewState」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ArtifactPreviewState =
  | { phase: "closed" }
  | {
      phase: "open";
      sessionId: string;
      fileReferenceId: string;
      file?: FileReference;
    };

/** 描述「ArtifactPreviewAction」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ArtifactPreviewAction =
  | { type: "preview/open"; sessionId: string; fileReferenceId: string }
  | { type: "preview/close" }
  | { type: "session/change"; sessionId: string | null }
  | { type: "file/loaded"; file: FileReference }
  | { type: "references/resolved"; expectedFileReferenceId: string; files: FileReference[] };

export const closedArtifactPreview: ArtifactPreviewState = { phase: "closed" };

/**
 * 预览只由用户显式打开。文件引用更新只能替换已打开的同 Session、同路径文件，不能自行打开面板。
 */
export function artifactPreviewReducer(
  state: ArtifactPreviewState,
  action: ArtifactPreviewAction,
): ArtifactPreviewState {
  if (action.type === "preview/open") {
    return {
      phase: "open",
      sessionId: action.sessionId,
      fileReferenceId: action.fileReferenceId,
    };
  }
  if (action.type === "preview/close") return closedArtifactPreview;
  if (action.type === "session/change") {
    return state.phase === "open" && state.sessionId === action.sessionId ? state : closedArtifactPreview;
  }
  if (action.type === "file/loaded") {
    if (
      state.phase !== "open" ||
      state.fileReferenceId !== action.file.fileReferenceId ||
      state.sessionId !== action.file.sessionId
    ) return state;
    return { ...state, file: action.file };
  }
  if (state.phase !== "open" || !state.file || state.fileReferenceId !== action.expectedFileReferenceId) {
    return state;
  }
  const latest = action.files.findLast(/** 执行「latest」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(file) =>
    file.sessionId === state.sessionId && file.relativePath === state.file?.relativePath);
  return latest
    ? { phase: "open", sessionId: state.sessionId, fileReferenceId: latest.fileReferenceId, file: latest }
    : state;
}

/** 执行「activeArtifactPreview」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function activeArtifactPreview(
  state: ArtifactPreviewState,
  sessionId: string | null,
): Extract<ArtifactPreviewState, { phase: "open" }> | null {
  return state.phase === "open" && state.sessionId === sessionId ? state : null;
}

/** 执行「fileReferenceIdsAfter」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function fileReferenceIdsAfter(ids: string[], currentId: string): string[] {
  const index = ids.lastIndexOf(currentId);
  return index < 0 ? [] : ids.slice(index + 1);
}

/** 执行「collectFileReferenceIds」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function collectFileReferenceIds(...collections: EntryCollection[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const collection of collections) {
    for (const id of collection.order) {
      const entry = collection.byId[id];
      if (!entry) continue;
      for (const fileReferenceId of entryFileReferenceIds(entry)) {
        if (seen.has(fileReferenceId)) continue;
        seen.add(fileReferenceId);
        result.push(fileReferenceId);
      }
    }
  }
  return result;
}

/** 执行「entryFileReferenceIds」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function entryFileReferenceIds(entry: ChatEntry): string[] {
  if (entry.type === "tool_call") {
    return entry.content.flatMap(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(item) =>
      item.type === "content" && item.content.type === "resource_link"
        ? parseFileReferenceUri(item.content.uri) ?? []
        : []);
  }
  if (entry.type === "message" || entry.type === "thought") {
    return entry.content.flatMap(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(item) =>
      item.type === "resource_link" ? parseFileReferenceUri(item.uri) ?? [] : []);
  }
  return [];
}
