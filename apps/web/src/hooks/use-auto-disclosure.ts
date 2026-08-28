import { useEffect, useRef, useState } from "react";

/** 描述「ActivityPhase」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ActivityPhase = "active" | "waiting" | "completed" | "failed" | "cancelled";

/** 每个 Activity Item 独立实例化：并行工具可以同时展开，用户手动选择优先。 */
export function useAutoDisclosure(phase: ActivityPhase, closeDelay = 800) {
  const active = phase === "active" || phase === "waiting" || phase === "failed";
  const [open, setOpenState] = useState(active);
  const userChoice = useRef<boolean | null>(null);
  const wasActive = useRef(active);

  useEffect(/** 同步组件生命周期内的外部状态，并在清理阶段释放订阅或临时资源。 */
() => {
    if (active) {
      wasActive.current = true;
      if (userChoice.current === null) setOpenState(true);
      return;
    }
    if (!wasActive.current || userChoice.current !== null) return;
    const timer = window.setTimeout(/** 执行受生命周期约束的定时任务，调用方负责在结束时取消句柄。 */
() => setOpenState(false), closeDelay);
    return /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */ () => window.clearTimeout(timer);
  }, [active, closeDelay]);

  /** 更新「setOpen」对应状态，并保持写入顺序、原子性与容量约束。 */
function setOpen(value: boolean) {
    userChoice.current = value;
    setOpenState(value);
  }

  return { open, setOpen };
}
