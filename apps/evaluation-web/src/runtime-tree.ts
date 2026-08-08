import type {
  ModelRoundTrace,
  ToolCallTrace,
  TurnTraceDocument,
} from "@kindergarten/evaluation-contract";

export interface RuntimeRoundNode {
  round: ModelRoundTrace;
  tools: ToolCallTrace[];
}

/** 工具按开始位置归属 Round，完成顺序只更新状态，不改变树的位置。 */
export function buildRuntimeTree(
  trace: Pick<TurnTraceDocument, "modelRounds" | "toolCalls">,
): RuntimeRoundNode[] {
  return trace.modelRounds
    .toSorted((a, b) => a.index - b.index)
    .map((round) => ({
      round,
      tools: trace.toolCalls
        .filter((tool) => tool.modelRoundId === round.id)
        .toSorted((a, b) => a.startedAt - b.startedAt),
    }));
}
