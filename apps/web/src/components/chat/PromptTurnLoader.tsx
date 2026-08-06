import { Loader } from "../primitives/Loader.js";

/** 整个 Prompt Turn 未结束时显示；不属于任何 Message、Thought 或 Tool。 */
export function PromptTurnLoader() {
  return <div className="prompt-turn-loader"><Loader variant="dots" size="sm" label="Agent 仍在工作" /></div>;
}
