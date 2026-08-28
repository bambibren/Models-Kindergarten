import * as Popover from "@radix-ui/react-popover";
import { useEffect, useRef, useState } from "react";
import {
  formatContextPercent,
  formatContextTokens,
  type ContextWindowUsageView,
} from "../../chat/context-window-usage.js";

/** 渲染「ContextWindowUsageIndicator」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function ContextWindowUsageIndicator({ demo = false, value }: { demo?: boolean; value: ContextWindowUsageView }) {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const closeTimer = useRef<number | undefined>(undefined);
  const percent = formatContextPercent(value.percent);
  const open = hovered || pinned;

  useEffect(/** 同步组件生命周期内的外部状态，并在清理阶段释放订阅或临时资源。 */
() => /** 同步组件生命周期内的外部状态，并在清理阶段释放订阅或临时资源。 */
() => window.clearTimeout(closeTimer.current), []);

  /** 执行「show」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function show() {
    window.clearTimeout(closeTimer.current);
    setHovered(true);
  }

  /** 执行「hideSoon」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function hideSoon() {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(/** 执行受生命周期约束的定时任务，调用方负责在结束时取消句柄。 */
() => setHovered(false), 120);
  }

  /** 根据已校验输入构建「togglePinned」结果，不额外持有调用方的大对象。 */
function togglePinned() {
    setPinned(/** 根据已校验输入构建「togglePinned」结果，不额外持有调用方的大对象。 */
(current) => {
      if (current) setHovered(false);
      return !current;
    });
  }

  return <Popover.Root onOpenChange={/** 处理「onOpenChange」事件，校验归属后再推进状态且避免重复提交。 */
(next) => {
    if (!next) {
      setHovered(false);
      setPinned(false);
    }
  }} open={open}>
    <Popover.Anchor asChild>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`上下文窗口已使用 ${percent}`}
        className={`context-window-trigger ${value.level}`}
        onClick={togglePinned}
        onKeyDown={/** 处理「onKeyDown」事件，校验归属后再推进状态且避免重复提交。 */
(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          togglePinned();
        }}
        onPointerEnter={show}
        onPointerLeave={hideSoon}
        type="button"
      >
        <svg aria-hidden="true" className="context-window-ring" viewBox="0 0 20 20">
          <circle className="context-window-ring-track" cx="10" cy="10" fill="none" pathLength="100" r="7" />
          <circle
            className="context-window-ring-value"
            cx="10"
            cy="10"
            fill="none"
            pathLength="100"
            r="7"
            strokeDasharray={`${value.ringPercent} 100`}
          />
        </svg>
      </button>
    </Popover.Anchor>
    <Popover.Portal>
      <Popover.Content
        align="end"
        className={`context-window-popover ${value.level}`}
        collisionPadding={12}
        onOpenAutoFocus={/** 处理「onOpenAutoFocus」事件，校验归属后再推进状态且避免重复提交。 */
(event) => event.preventDefault()}
        onPointerEnter={show}
        onPointerLeave={hideSoon}
        side="top"
        sideOffset={9}
      >
        <header><strong>上下文窗口</strong><span>{percent}</span></header>
        <div className="context-window-meter"><span style={{ width: `${value.ringPercent}%` }} /></div>
        <p>当前会话约 {formatContextTokens(value.estimatedTokens)} / {formatContextTokens(value.windowTokens)} tokens</p>
        <p>剩余约 {formatContextTokens(value.remainingTokens)} tokens</p>
        <small>{demo ? "UI Demo 数据。" : ""}按下一次请求会携带的完整保留上下文估算；不含输入框中尚未发送的草稿，实际发送时会随新 Prompt 和历史裁剪变化。</small>
        <Popover.Arrow className="context-window-popover-arrow" />
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
