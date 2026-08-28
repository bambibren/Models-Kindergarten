import type { DemoAgentStrategy } from "../demo-types.js";

export const demoAgentStorageKey = "models-kindergarten.demo-agents";

/** 描述「AgentStorage」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface AgentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 读取「loadSavedAgents」所需数据，并遵守作用域、分页与容量边界。 */
export function loadSavedAgents(storage: AgentStorage): DemoAgentStrategy[] {
  const raw = storage.getItem(demoAgentStorageKey);
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter(isAgentStrategy).map(stripRemovedFields);
  } catch {
    return [];
  }
}

/** 更新「saveAgent」对应状态，并保持写入顺序、原子性与容量约束。 */
export function saveAgent(storage: AgentStorage, agent: DemoAgentStrategy): DemoAgentStrategy[] {
  const current = loadSavedAgents(storage);
  const saved = stripRemovedFields(agent);
  const next = [saved, ...current.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(candidate) => candidate.id !== saved.id)];
  storage.setItem(demoAgentStorageKey, JSON.stringify(next));
  return next;
}

/** 汇总「mergeAgentStrategies」对应指标，保持缺失字段语义且不重复计算同一来源。 */
export function mergeAgentStrategies(saved: DemoAgentStrategy[], builtIns: DemoAgentStrategy[]): DemoAgentStrategy[] {
  const savedIds = new Set(saved.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(agent) => agent.id));
  return [...saved, ...builtIns.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(agent) => !savedIds.has(agent.id))];
}

/** 判断「isAgentStrategy」对应条件，只返回判定结果且不修改输入状态。 */
function isAgentStrategy(value: unknown): value is DemoAgentStrategy {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DemoAgentStrategy>;
  return typeof candidate.id === "string"
    && typeof candidate.name === "string"
    && typeof candidate.description === "string"
    && Array.isArray(candidate.modules)
    && typeof candidate.updatedAt === "string"
    && (candidate.state === "active" || candidate.state === "draft");
}

/** 执行「stripRemovedFields」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function stripRemovedFields(agent: DemoAgentStrategy): DemoAgentStrategy {
  const { defaultReasoningProfile: _removed, ...current } = agent as DemoAgentStrategy & { defaultReasoningProfile?: unknown };
  return current;
}
