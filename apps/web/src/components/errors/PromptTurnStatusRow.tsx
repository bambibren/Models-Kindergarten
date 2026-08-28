import { CircleAlert, CircleStop, RotateCcw } from "lucide-react";
import type {
  PromptTurnState,
  TurnAction,
} from "../../prompt-turn/prompt-turn-types.js";

/** 渲染「PromptTurnStatusRow」界面投影，所有业务事实仍由上层状态与服务端提供。 */
export function PromptTurnStatusRow({ state, onAction }: {
  state: PromptTurnState;
  onAction: (action: TurnAction) => void;
}) {
  if (state.status === "cancelled") {
    return <div className="prompt-turn-status cancelled" role="status">
      <CircleStop size={15} />
      <span>已停止生成</span>
    </div>;
  }
  if (state.status === "interrupted") {
    return <div className="prompt-turn-status failed" role="alert">
      <CircleAlert size={15} />
      <div><strong>Remote 重启，本轮已中断</strong></div>
      {state.actions.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(action) => <button type="button" key={action.type} onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => onAction(action)}><RotateCcw size={13} />{action.label}</button>)}
    </div>;
  }
  if (state.status === "completed" && state.reason !== "end_turn") {
    return <div className="prompt-turn-status warning" role="status">
      <CircleAlert size={15} />
      <span>{completionMessage(state.reason)}</span>
    </div>;
  }
  if (state.status !== "failed") return null;
  return <div className="prompt-turn-status failed" role="alert">
    <CircleAlert size={15} />
    <div><strong>{state.failure.message}</strong></div>
    {state.actions.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(action) => <button type="button" key={action.type} onClick={/** 处理「onClick」事件，校验归属后再推进状态且避免重复提交。 */
() => onAction(action)}>
      <RotateCcw size={13} />{action.label}
    </button>)}
  </div>;
}

/** 执行「completionMessage」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function completionMessage(reason: Extract<PromptTurnState, { status: "completed" }>["reason"]): string {
  if (reason === "max_tokens") return "回答达到模型输出上限";
  if (reason === "max_turn_requests") return "回答达到 Agent Turn 请求上限";
  return "模型拒绝了当前请求";
}
