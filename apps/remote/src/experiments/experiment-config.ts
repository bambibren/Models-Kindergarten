/** Context Experiment 的服务端固定配置；浏览器不提供工作表模型选择入口。 */
export interface ExperimentConfig {
  worksheetModelDisplayName: string;
}

/** 工作表整理统一使用账号下名为“大聪明”的 Ready ModelStudent。 */
export const EXPERIMENT_CONFIG: ExperimentConfig = Object.freeze({
  worksheetModelDisplayName: "大聪明",
});
