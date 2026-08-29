import type {
  ModelRoundTrace,
  ToolCallTrace,
  TurnTraceDocument,
} from "@kindergarten/evaluation-contract";

/** 描述「RuntimeRoundNode」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface RuntimeRoundNode {
  round: ModelRoundTrace;
  tools: ToolCallTrace[];
}

/** 工具按开始位置归属 Round，完成顺序只更新状态，不改变树的位置。 */
export function buildRuntimeTree(
  trace: Pick<TurnTraceDocument, "modelRounds" | "toolCalls">,
): RuntimeRoundNode[] {
  return trace.modelRounds
    .toSorted(/** 执行「map」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(a, b) => a.index - b.index)
    .map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(round) => ({
      round,
      tools: trace.toolCalls
        .filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(tool) => tool.modelRoundId === round.id)
        .toSorted(/** 根据已校验输入构建「tools」结果，不额外持有调用方的大对象。 */
(a, b) => a.startedAt - b.startedAt),
    }));
}
