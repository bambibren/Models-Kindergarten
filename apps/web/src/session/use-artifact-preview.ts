import type { FileReference } from "@kindergarten/contracts";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { controlApi } from "../api/control-api.js";
import type { EntryCollection } from "../chat/chat-types.js";
import {
  activeArtifactPreview,
  artifactPreviewReducer,
  closedArtifactPreview,
  collectFileReferenceIds,
  fileReferenceIdsAfter,
} from "./artifact-preview-state.js";

export function useArtifactPreview(
  sessionId: string | null,
  history: EntryCollection,
  streaming: EntryCollection,
) {
  const [state, dispatch] = useReducer(artifactPreviewReducer, closedArtifactPreview);
  const cacheRef = useRef(new Map<string, FileReference>());
  const ids = useMemo(() => collectFileReferenceIds(history, streaming), [history, streaming]);
  const idsKey = ids.join("\0");
  const artifact = activeArtifactPreview(state, sessionId);

  useEffect(() => {
    cacheRef.current.clear();
    dispatch({ type: "session/change", sessionId });
  }, [sessionId]);

  useEffect(() => {
    // closed 状态只保留聊天中的预览链接，不读取元数据，也不会自动打开预览。
    if (!artifact?.file) return;
    const candidateIds = fileReferenceIdsAfter(ids, artifact.fileReferenceId);
    if (candidateIds.length === 0) return;
    let disposed = false;
    const load = async () => Promise.all(candidateIds.map(async (id) => {
      const cached = cacheRef.current.get(id);
      if (cached) return cached;
      const file = await controlApi.fileReference(id);
      cacheRef.current.set(id, file);
      return file;
    }));
    void load().then((files) => {
      if (!disposed) dispatch({
        type: "references/resolved",
        expectedFileReferenceId: artifact.fileReferenceId,
        files,
      });
    }).catch((error: unknown) => {
      if (!disposed) console.error("同步最新文件预览失败", error);
    });
    return () => { disposed = true; };
  }, [artifact?.file?.relativePath, artifact?.fileReferenceId, artifact?.sessionId, idsKey]);

  const open = useCallback((fileReferenceId: string) => {
    if (sessionId) dispatch({ type: "preview/open", sessionId, fileReferenceId });
  }, [sessionId]);
  const close = useCallback(() => dispatch({ type: "preview/close" }), []);
  const fileLoaded = useCallback((file: FileReference) => {
    cacheRef.current.set(file.fileReferenceId, file);
    dispatch({ type: "file/loaded", file });
  }, []);

  return { artifact, open, close, fileLoaded };
}
