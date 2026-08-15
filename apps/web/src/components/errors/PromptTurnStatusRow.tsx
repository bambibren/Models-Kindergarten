import { CircleAlert, CircleStop, RotateCcw } from "lucide-react";
import type {
  PromptTurnState,
  TurnAction,
} from "../../prompt-turn/prompt-turn-types.js";

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
      {state.actions.map((action) => <button type="button" key={action.type} onClick={() => onAction(action)}><RotateCcw size={13} />{action.label}</button>)}
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
    {state.actions.map((action) => <button type="button" key={action.type} onClick={() => onAction(action)}>
      <RotateCcw size={13} />{action.label}
    </button>)}
  </div>;
}

function completionMessage(reason: Extract<PromptTurnState, { status: "completed" }>["reason"]): string {
  if (reason === "max_tokens") return "回答达到模型输出上限";
  if (reason === "max_turn_requests") return "回答达到 Agent Turn 请求上限";
  return "模型拒绝了当前请求";
}
