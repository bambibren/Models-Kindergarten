import { describe, expect, it } from "vitest";
import type { AgentRecord, ExperimentContextPolicy } from "@kindergarten/contracts";
import { addContextLane, importAgentIntoLane, initialContextLanes, removeContextLane, testDraftFromLane, updateContextLane } from "./context-lab-state.js";

const policy: ExperimentContextPolicy = {
  systemPrompt: "先理解任务。",
  builtinTools: [{ toolId: "read_file", enabled: true, permission: "allow" }],
  builtinSkillIds: ["builtin:sandbox-notes"],
  skillInstallationIds: ["skill-a"], mcps: [],
  historyPolicy: { mode: "recent_turns", maxTurns: 6 }, memoryPolicy: { mode: "off" },
};
const agent: AgentRecord = {
  schemaVersion: 1, agentId: "agent-a", ownerId: "local-admin", name: "Agent A",
  systemPrompt: policy.systemPrompt, builtinTools: policy.builtinTools,
  builtinSkills: [{ skillId: "builtin:sandbox-notes", enabled: true }],
  skills: [{ skillInstallationId: "skill-a", enabled: true }], mcps: [],
  historyPolicy: policy.historyPolicy, memoryPolicy: { mode: "off" },
  createdAt: "2026-08-18T00:00:00.000Z", updatedAt: "2026-08-18T00:00:00.000Z",
};

describe("context-lab-state V2", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("A/B 从相同且隔离的 Agent 配置开始", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const lanes = initialContextLanes(agent, policy);
    expect(lanes.map(/** 构造「toEqual」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(item) => item.label)).toEqual(["A", "B"]);
    expect(lanes[0]?.policy).toEqual(lanes[1]?.policy);
    expect(lanes[0]?.policy).not.toBe(lanes[1]?.policy);
  });

  it("生成草稿时为每个 Test 填入同一模型和推理档位", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const lanes = initialContextLanes(agent, policy);
    const tests = lanes.map((lane) => testDraftFromLane(lane, "model-a", "deep"));
    expect(tests.map((test) => [test.modelStudentId, test.reasoningProfile])).toEqual([
      ["model-a", "deep"], ["model-a", "deep"],
    ]);
  });

  it("C 完整复制当前 Test 后保持独立，且可以删除", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const lanes = updateContextLane(initialContextLanes(agent, policy), "missing", {});
    lanes[1]!.policy.systemPrompt = "B 的人工修改";
    const withC = addContextLane(lanes, lanes[1]!.testId);
    expect(withC[2]).toMatchObject({ label: "C" });
    expect(withC[2]?.policy.systemPrompt).toBe("B 的人工修改");
    expect(withC[2]?.policy).not.toBe(withC[1]?.policy);
    expect(removeContextLane(withC, withC[2]!.testId).map(/** 构造「toEqual」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(item) => item.label)).toEqual(["A", "B"]);
  });

  it("导入 Agent 只替换当前 Test 的 Agent 策略", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const lanes = initialContextLanes(agent, policy);
    const imported = { ...agent, agentId: "agent-b", name: "Agent B", systemPrompt: "导入的提示" };
    const next = importAgentIntoLane(lanes, lanes[1]!.testId, imported);
    expect(next[1]).toMatchObject({ sourceAgent: { agentId: "agent-b" } });
    expect(next[1]?.policy.systemPrompt).toBe("导入的提示");
  });
});
