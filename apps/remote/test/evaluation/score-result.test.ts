import { describe, expect, it } from "vitest";
import type { ScoreResultUpsertInput } from "@kindergarten/evaluation-contract";
import { aggregateModelScoreGroups, buildScoreResult, modelScoreGroupDetail } from "../../src/evaluation/score-result.js";

describe("atomic score results", () => {
  it("同一模型与冻结配置聚合为一条平均分和区间，并按平均分降序", () => {
    const first = buildScoreResult(input("turn-1", 80, "balanced", "2026-09-01T10:00:00.000Z"));
    const secondInput = input("turn-2", 100, "balanced", "2026-09-02T10:00:00.000Z");
    secondInput.agentConfiguration.agentId = "agent-2";
    secondInput.agentConfiguration.agentName = "同配置的重命名助手";
    secondInput.agentConfiguration.agentSnapshotHash = "snapshot-name-changed";
    const second = buildScoreResult(secondInput);
    const other = buildScoreResult(input("turn-3", 95, "deep", "2026-09-02T11:00:00.000Z"));
    const groups = aggregateModelScoreGroups([first, second, other], "owner-1", "model-1");

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ sampleCount: 1, averageScore: 95, minScore: 95, maxScore: 95 });
    expect(groups[1]).toMatchObject({ sampleCount: 2, averageScore: 90, minScore: 80, maxScore: 100 });
    expect(modelScoreGroupDetail([first, second, other], "owner-1", "model-1", groups[1]!.configurationHash)?.history
      .map((item) => item.sourceTitle)).toEqual(["turn-2", "turn-1"]);
  });

  it("同一来源重复保存沿用稳定 ID 和首次创建时间，草稿不进入排行", () => {
    const initial = buildScoreResult({ ...input("turn-1", 80, "balanced", "2026-09-01T10:00:00.000Z"), completed: false });
    const completed = buildScoreResult(input("turn-1", 90, "balanced", "2026-09-02T10:00:00.000Z"), initial);

    expect(completed.scoreResultId).toBe(initial.scoreResultId);
    expect(completed.createdAt).toBe(initial.createdAt);
    expect(aggregateModelScoreGroups([initial], "owner-1", "model-1")).toEqual([]);
  });
});

function input(turnId: string, score: number, profile: "balanced" | "deep", recordedAt: string): ScoreResultUpsertInput {
  return {
    ownerId: "owner-1",
    modelStudentId: "model-1",
    source: { kind: "turn_effect", sessionId: "session-1", turnId },
    sourceTitle: turnId,
    agentConfiguration: {
      agentSnapshotHash: "agent-snapshot-1",
      agentId: "agent-1",
      agentName: "研究助手",
      systemPrompt: "严谨回答",
      builtinTools: [], builtinSkills: [], skills: [], mcps: [],
      historyPolicy: { mode: "none" }, memoryPolicy: { mode: "off" },
      reasoning: {
        schemaVersion: 1,
        requestedProfile: profile,
        resolvedProfile: profile,
        source: "model_default",
        providerKind: "fixture",
        model: "fixture-model",
        native: { effort: profile },
      },
    },
    dimensionScores: { understanding: score, planning: score, output: score, execution: score },
    completed: true,
    recordedAt,
  };
}
