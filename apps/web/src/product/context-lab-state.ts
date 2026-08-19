import type { AgentRecord, ExperimentContextPolicy, ReasoningProfile } from "@kindergarten/contracts";

export interface ContextLabLane {
  testId: string;
  label: "A" | "B" | "C";
  sourceAgent: { agentId: string; name: string; updatedAt: string };
  modelStudentId: string;
  reasoningProfile: ReasoningProfile;
  policy: ExperimentContextPolicy;
}

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

export function addContextLane(lanes: ContextLabLane[], activeTestId: string): ContextLabLane[] {
  if (lanes.length >= 3 || lanes.some((item) => item.label === "C")) return lanes;
  const source = lanes.find((item) => item.testId === activeTestId) ?? lanes[1] ?? lanes[0];
  if (!source) return lanes;
  return [...lanes, {
    ...structuredClone(source),
    testId: globalThis.crypto.randomUUID(),
    label: "C",
  }];
}

export function removeContextLane(lanes: ContextLabLane[], testId: string): ContextLabLane[] {
  return lanes.filter((item) => item.testId !== testId || item.label !== "C");
}

export function updateContextLane(
  lanes: ContextLabLane[],
  testId: string,
  change: Partial<Pick<ContextLabLane, "modelStudentId" | "reasoningProfile" | "policy">>,
): ContextLabLane[] {
  return lanes.map((item) => item.testId === testId ? { ...item, ...structuredClone(change) } : item);
}

export function importAgentIntoLane(
  lanes: ContextLabLane[],
  testId: string,
  agent: AgentRecord,
): ContextLabLane[] {
  return lanes.map((item) => item.testId === testId ? {
    ...item,
    sourceAgent: sourceAgentRef(agent),
    policy: structuredClone(policyFromAgent(agent)),
  } : item);
}

export function sourceAgentRef(agent: AgentRecord): ContextLabLane["sourceAgent"] {
  return { agentId: agent.agentId, name: agent.name, updatedAt: agent.updatedAt };
}

export function policyFromAgent(agent: AgentRecord): ExperimentContextPolicy {
  return {
    systemPrompt: agent.systemPrompt,
    builtinTools: structuredClone(agent.builtinTools),
    skillInstallationIds: agent.skills.filter((item) => item.enabled).map((item) => item.skillInstallationId),
    mcps: structuredClone(agent.mcps),
    historyPolicy: structuredClone(agent.historyPolicy),
    memoryPolicy: { mode: "off" },
  };
}

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
