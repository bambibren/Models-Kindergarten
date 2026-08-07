import { CircleAlert, CircleStop, RotateCcw } from "lucide-react";
import type {
  PromptTurnState,
  TurnAction,
} from "../../prompt-turn/prompt-turn-types.js";

export function PromptTurnStatusRow({ state, onAction }: {
  state: PromptTurnState;
  onAction: (action: TurnAction) => void;
}) {
  if (state.phase === "cancelled") {
    return <div className="prompt-turn-status cancelled" role="status">
      <CircleStop size={15} />
      <span>已停止生成</span>
    </div>;
  }
  if (state.phase === "completed" && state.reason !== "end_turn") {
    return <div className="prompt-turn-status warning" role="status">
      <CircleAlert size={15} />
      <span>{completionMessage(state.reason)}</span>
    </div>;
  }
  if (state.phase !== "failed") return null;
  return <div className="prompt-turn-status failed" role="alert">
    <CircleAlert size={15} />
    <div><strong>{state.failure.message}</strong></div>
    {state.actions.map((action) => <button type="button" key={action.type} onClick={() => onAction(action)}>
      <RotateCcw size={13} />{action.label}
    </button>)}
  </div>;
}

function completionMessage(reason: Extract<PromptTurnState, { phase: "completed" }>["reason"]): string {
  if (reason === "max_tokens") return "回答达到模型输出上限";
  if (reason === "max_turn_requests") return "回答达到 Agent Turn 请求上限";
  return "模型拒绝了当前请求";
}
