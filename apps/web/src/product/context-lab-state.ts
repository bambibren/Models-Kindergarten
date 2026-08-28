import type { AgentRecord, ExperimentContextPolicy, ReasoningProfile } from "@kindergarten/contracts";

/** 描述「ContextLabLane」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ContextLabLane {
  testId: string;
  label: "A" | "B" | "C";
  sourceAgent: { agentId: string; name: string; updatedAt: string };
  modelStudentId: string;
  reasoningProfile: ReasoningProfile;
  policy: ExperimentContextPolicy;
}

/** 执行「initialContextLanes」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function initialContextLanes(
  agent: AgentRecord,
  policy: ExperimentContextPolicy,
  modelStudentId: string,
  reasoningProfile: ReasoningProfile = "auto",
): ContextLabLane[] {
  return [
    makeContextLane("A", agent, policy, modelStudentId, reasoningProfile),
    makeContextLane("B", agent, policy, modelStudentId, reasoningProfile),
  ];
}

/** 执行「addContextLane」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function addContextLane(lanes: ContextLabLane[], activeTestId: string): ContextLabLane[] {
  if (lanes.length >= 3 || lanes.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.label === "C")) return lanes;
  const source = lanes.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.testId === activeTestId) ?? lanes[1] ?? lanes[0];
  if (!source) return lanes;
  return [...lanes, {
    ...structuredClone(source),
    testId: globalThis.crypto.randomUUID(),
    label: "C",
  }];
}

/** 释放或删除「removeContextLane」对应资源，重复调用仍保持安全。 */
export function removeContextLane(lanes: ContextLabLane[], testId: string): ContextLabLane[] {
  return lanes.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.testId !== testId || item.label !== "C");
}

/** 更新「updateContextLane」对应状态，并保持写入顺序、原子性与容量约束。 */
export function updateContextLane(
  lanes: ContextLabLane[],
  testId: string,
  change: Partial<Pick<ContextLabLane, "modelStudentId" | "reasoningProfile" | "policy">>,
): ContextLabLane[] {
  return lanes.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.testId === testId ? { ...item, ...structuredClone(change) } : item);
}

/** 执行「importAgentIntoLane」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function importAgentIntoLane(
  lanes: ContextLabLane[],
  testId: string,
  agent: AgentRecord,
): ContextLabLane[] {
  return lanes.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.testId === testId ? {
    ...item,
    sourceAgent: sourceAgentRef(agent),
    policy: structuredClone(policyFromAgent(agent)),
  } : item);
}

/** 执行「sourceAgentRef」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function sourceAgentRef(agent: AgentRecord): ContextLabLane["sourceAgent"] {
  return { agentId: agent.agentId, name: agent.name, updatedAt: agent.updatedAt };
}

/** 执行「policyFromAgent」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function policyFromAgent(agent: AgentRecord): ExperimentContextPolicy {
  return {
    systemPrompt: agent.systemPrompt,
    builtinTools: structuredClone(agent.builtinTools),
    skillInstallationIds: agent.skills.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.enabled).map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.skillInstallationId),
    mcps: structuredClone(agent.mcps),
    historyPolicy: structuredClone(agent.historyPolicy),
    memoryPolicy: { mode: "off" },
  };
}

/** 根据已校验输入构建「makeContextLane」结果，不额外持有调用方的大对象。 */
function makeContextLane(
  label: ContextLabLane["label"],
  agent: AgentRecord,
  policy: ExperimentContextPolicy,
  modelStudentId: string,
  reasoningProfile: ReasoningProfile,
): ContextLabLane {
  return {
    testId: globalThis.crypto.randomUUID(),
    label,
    sourceAgent: sourceAgentRef(agent),
    modelStudentId,
    reasoningProfile,
    policy: structuredClone(policy),
  };
}
