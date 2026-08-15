import { Loader } from "../primitives/Loader.js";
import type { ActivePromptTurnState } from "../../prompt-turn/prompt-turn-types.js";

/** 整个 Prompt Turn 未结束时显示；不属于任何 Message、Thought 或 Tool。 */
export function PromptTurnLoader({ turn }: { turn: ActivePromptTurnState }) {
  return <div className="prompt-turn-loader"><Loader variant="dots" size="sm" label={phaseLabel(turn)} /></div>;
}

function phaseLabel(turn: ActivePromptTurnState): string {
  if (turn.waitingFor.permission > 0) return "等待你授权工具";
  if (turn.waitingFor.input > 0) return "等待你回答问题";
  if (turn.phase === "accepted") return "已接收请求";
  if (turn.phase === "preparing_context") return "正在准备上下文";
  if (turn.phase === "model_streaming") return "模型正在生成";
  if (turn.phase === "tool_execution") return "正在执行工具";
  return "正在保存本轮结果";
}
