import { describe, expect, it } from "vitest";
import type { AgentRecord, ExperimentContextPolicy } from "@kindergarten/contracts";
import { addContextLane, importAgentIntoLane, initialContextLanes, removeContextLane, updateContextLane } from "./context-lab-state.js";

const policy: ExperimentContextPolicy = {
  systemPrompt: "先理解任务。",
  builtinTools: [{ toolId: "read_file", enabled: true, permission: "allow" }],
  skillInstallationIds: ["skill-a"], mcps: [],
  historyPolicy: { mode: "recent_turns", maxTurns: 6 }, memoryPolicy: { mode: "off" },
};
const agent: AgentRecord = {
  schemaVersion: 1, agentId: "agent-a", ownerId: "local-admin", name: "Agent A",
  systemPrompt: policy.systemPrompt, builtinTools: policy.builtinTools,
  skills: [{ skillInstallationId: "skill-a", enabled: true }], mcps: [],
  historyPolicy: policy.historyPolicy, memoryPolicy: { mode: "off" },
  createdAt: "2026-08-18T00:00:00.000Z", updatedAt: "2026-08-18T00:00:00.000Z",
};

describe("context-lab-state V2", () => {
  it("A/B 从相同且隔离的 Agent、模型和推理配置开始", () => {
    const lanes = initialContextLanes(agent, policy, "model-a", "auto");
    expect(lanes.map((item) => item.label)).toEqual(["A", "B"]);
    expect(lanes.every((item) => item.modelStudentId === "model-a" && item.reasoningProfile === "auto")).toBe(true);
    expect(lanes[0]?.policy).toEqual(lanes[1]?.policy);
    expect(lanes[0]?.policy).not.toBe(lanes[1]?.policy);
  });

  it("每个 Test 可独立修改模型和推理档位", () => {
    const lanes = initialContextLanes(agent, policy, "model-a");
    const next = updateContextLane(lanes, lanes[1]!.testId, { modelStudentId: "model-b", reasoningProfile: "deep" });
    expect(next[0]).toMatchObject({ modelStudentId: "model-a", reasoningProfile: "auto" });
    expect(next[1]).toMatchObject({ modelStudentId: "model-b", reasoningProfile: "deep" });
  });

  it("C 完整复制当前 Test 后保持独立，且可以删除", () => {
    const lanes = updateContextLane(initialContextLanes(agent, policy, "model-a"), "missing", {});
    lanes[1]!.policy.systemPrompt = "B 的人工修改";
    lanes[1]!.reasoningProfile = "deep";
    const withC = addContextLane(lanes, lanes[1]!.testId);
    expect(withC[2]).toMatchObject({ label: "C", modelStudentId: "model-a", reasoningProfile: "deep" });
    expect(withC[2]?.policy.systemPrompt).toBe("B 的人工修改");
    expect(withC[2]?.policy).not.toBe(withC[1]?.policy);
    expect(removeContextLane(withC, withC[2]!.testId).map((item) => item.label)).toEqual(["A", "B"]);
  });

  it("导入 Agent 只替换当前 Test 的 Agent 策略，不改模型和推理", () => {
    const lanes = initialContextLanes(agent, policy, "model-a", "deep");
    const imported = { ...agent, agentId: "agent-b", name: "Agent B", systemPrompt: "导入的提示" };
    const next = importAgentIntoLane(lanes, lanes[1]!.testId, imported);
    expect(next[1]).toMatchObject({ sourceAgent: { agentId: "agent-b" }, modelStudentId: "model-a", reasoningProfile: "deep" });
    expect(next[1]?.policy.systemPrompt).toBe("导入的提示");
  });
});
