import { describe, expect, it } from "vitest";
import type { ScoreResultRecord } from "@kindergarten/evaluation-contract";
import { scoreResultSourceUrl } from "./score-result-link.js";

describe("scoreResultSourceUrl", () => {
  it("按原子事实链接上下文实验的具体 Test", () => {
    expect(scoreResultSourceUrl(record({ kind: "context_experiment", experimentId: "实验/1", testId: "test-a", scorecardId: "card-1" })))
      .toBe("/evaluation/experiments/%E5%AE%9E%E9%AA%8C%2F1?scoreResultId=score-1&testId=test-a");
  });

  it("按原子事实链接单轮效果打分页", () => {
    expect(scoreResultSourceUrl(record({ kind: "turn_effect", sessionId: "session-1", turnId: "turn/1" })))
      .toBe("/evaluation/sessions/session-1/turns/turn%2F1?scoreResultId=score-1");
  });
});

function record(source: ScoreResultRecord["source"]): ScoreResultRecord {
  return {
    schemaVersion: 1, scoreResultId: "score-1", ownerId: "owner-1", modelStudentId: "model-1", source,
    sourceTitle: "评分", status: "complete", totalScore: 90, createdAt: "now", updatedAt: "now",
    dimensionScores: { understanding: 90, planning: 90, output: 90, execution: 90 },
    agentConfiguration: {
      configurationHash: "config-1", agentSnapshotHash: "snapshot-1", agentId: "agent-1", agentName: "Agent",
      systemPrompt: "", builtinTools: [], builtinSkills: [], skills: [], mcps: [], historyPolicy: { mode: "none" }, memoryPolicy: { mode: "off" },
      reasoning: { schemaVersion: 1, requestedProfile: "balanced", resolvedProfile: "balanced", source: "model_default", providerKind: "fixture", model: "fixture", native: {} },
    },
  };
}
