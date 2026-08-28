import { useCallback, useEffect, useState } from "react";

/** 描述「ResourceState」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ResourceState<T> =
  | { phase: "loading" }
  | { phase: "ready"; data: T }
  | { phase: "empty"; data: T }
  | { phase: "error"; message: string; requestId?: string };

const neverEmpty = /** 执行「neverEmpty」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => false;

/** 执行「useResource」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function useResource<T>(load: () => Promise<T>, isEmpty: (value: T) => boolean = neverEmpty) {
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<ResourceState<T>>({ phase: "loading" });
  const retry = useCallback(/** 缓存「retry」的派生计算，依赖变化时重新生成以避免陈旧闭包。 */
() => setNonce(/** 执行「retry」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(value) => value + 1), []);
  useEffect(/** 同步组件生命周期内的外部状态，并在清理阶段释放订阅或临时资源。 */
() => {
    let disposed = false;
    setState({ phase: "loading" });
    void load().then(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
(data) => {
      if (!disposed) setState(isEmpty(data) ? { phase: "empty", data } : { phase: "ready", data });
    }).catch(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
(error: unknown) => {
      if (!disposed) setState({
        phase: "error",
        message: error instanceof Error ? error.message : String(error),
        ...(typeof error === "object" && error && "requestId" in error && typeof error.requestId === "string" ? { requestId: error.requestId } : {}),
      });
    });
    return /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */ () => { disposed = true; };
  }, [load, isEmpty, nonce]);
  return { state, retry };
}
