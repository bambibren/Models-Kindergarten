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

/** 执行「useArtifactPreview」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function useArtifactPreview(
  sessionId: string | null,
  history: EntryCollection,
  streaming: EntryCollection,
) {
  const [state, dispatch] = useReducer(artifactPreviewReducer, closedArtifactPreview);
  const cacheRef = useRef(new Map<string, FileReference>());
  const ids = useMemo(/** 缓存「ids」的派生计算，依赖变化时重新生成以避免陈旧闭包。 */
() => collectFileReferenceIds(history, streaming), [history, streaming]);
  const idsKey = ids.join("\0");
  const artifact = activeArtifactPreview(state, sessionId);

  useEffect(/** 同步组件生命周期内的外部状态，并在清理阶段释放订阅或临时资源。 */
() => {
    cacheRef.current.clear();
    dispatch({ type: "session/change", sessionId });
  }, [sessionId]);

  useEffect(/** 同步组件生命周期内的外部状态，并在清理阶段释放订阅或临时资源。 */
() => {
    // closed 状态只保留聊天中的预览链接，不读取元数据，也不会自动打开预览。
    if (!artifact?.file) return;
    const candidateIds = fileReferenceIdsAfter(ids, artifact.fileReferenceId);
    if (candidateIds.length === 0) return;
    let disposed = false;
    const load = /** 读取「load」所需数据，并遵守作用域、分页与容量边界。 */
async () => Promise.all(candidateIds.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
async (id) => {
      const cached = cacheRef.current.get(id);
      if (cached) return cached;
      const file = await controlApi.fileReference(id);
      cacheRef.current.set(id, file);
      return file;
    }));
    void load().then(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
(files) => {
      if (!disposed) dispatch({
        type: "references/resolved",
        expectedFileReferenceId: artifact.fileReferenceId,
        files,
      });
    }).catch(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
(error: unknown) => {
      if (!disposed) console.error("同步最新文件预览失败", error);
    });
    return /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */ () => { disposed = true; };
  }, [artifact?.file?.relativePath, artifact?.fileReferenceId, artifact?.sessionId, idsKey]);

  const open = useCallback(/** 缓存「open」的派生计算，依赖变化时重新生成以避免陈旧闭包。 */
(fileReferenceId: string) => {
    if (sessionId) dispatch({ type: "preview/open", sessionId, fileReferenceId });
  }, [sessionId]);
  const close = useCallback(/** 缓存「close」的派生计算，依赖变化时重新生成以避免陈旧闭包。 */
() => dispatch({ type: "preview/close" }), []);
  const fileLoaded = useCallback(/** 缓存「fileLoaded」的派生计算，依赖变化时重新生成以避免陈旧闭包。 */
(file: FileReference) => {
    cacheRef.current.set(file.fileReferenceId, file);
    dispatch({ type: "file/loaded", file });
  }, []);

  return { artifact, open, close, fileLoaded };
}
