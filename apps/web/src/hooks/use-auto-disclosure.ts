import { useEffect, useRef, useState } from "react";

export type ActivityPhase = "active" | "waiting" | "completed" | "failed" | "cancelled";

/** 每个 Activity Item 独立实例化：并行工具可以同时展开，用户手动选择优先。 */
export function useAutoDisclosure(phase: ActivityPhase, closeDelay = 800) {
  const active = phase === "active" || phase === "waiting" || phase === "failed";
  const [open, setOpenState] = useState(active);
  const userChoice = useRef<boolean | null>(null);
  const wasActive = useRef(active);

  useEffect(() => {
    if (active) {
      wasActive.current = true;
      if (userChoice.current === null) setOpenState(true);
      return;
    }
    if (!wasActive.current || userChoice.current !== null) return;
    const timer = window.setTimeout(() => setOpenState(false), closeDelay);
    return () => window.clearTimeout(timer);
  }, [active, closeDelay]);

  function setOpen(value: boolean) {
    userChoice.current = value;
    setOpenState(value);
  }

  return { open, setOpen };
}
