import { useCallback, useEffect, useState } from "react";

export type ResourceState<T> =
  | { phase: "loading" }
  | { phase: "ready"; data: T }
  | { phase: "empty"; data: T }
  | { phase: "error"; message: string; requestId?: string };

const neverEmpty = () => false;

export function useResource<T>(load: () => Promise<T>, isEmpty: (value: T) => boolean = neverEmpty) {
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<ResourceState<T>>({ phase: "loading" });
  const retry = useCallback(() => setNonce((value) => value + 1), []);
  useEffect(() => {
    let disposed = false;
    setState({ phase: "loading" });
    void load().then((data) => {
      if (!disposed) setState(isEmpty(data) ? { phase: "empty", data } : { phase: "ready", data });
    }).catch((error: unknown) => {
      if (!disposed) setState({
        phase: "error",
        message: error instanceof Error ? error.message : String(error),
        ...(typeof error === "object" && error && "requestId" in error && typeof error.requestId === "string" ? { requestId: error.requestId } : {}),
      });
    });
    return () => { disposed = true; };
  }, [load, isEmpty, nonce]);
  return { state, retry };
}
