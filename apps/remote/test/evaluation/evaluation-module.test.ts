import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvaluationModule } from "../../src/evaluation/evaluation-module.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Evaluation 模块", () => {
  it("异步保存并通过同源只读接口查询完整评测", async () => {
    const evaluation = await createEvaluation();
    completeTurn(evaluation, "session", "turn");
    await evaluation.flush();

    expect(await evaluation.get("session", "turn")).toMatchObject({
      trace: { sessionId: "session", turnId: "turn" },
      result: { normallyCompleted: true, modelRoundCount: 0 },
    });
    const response = await evaluation.fetch(
      new Request("http://remote/api/evaluation/v1/turn-evaluations/session/turn"),
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ result: { normallyCompleted: true } });
  });

  it("只接管评测读取路径，并拒绝浏览器写入", async () => {
    const evaluation = await createEvaluation();
    await expect(evaluation.fetch(new Request("http://remote/api/control/v1/sessions")))
      .resolves.toBeUndefined();
    expect((await evaluation.fetch(new Request(
      "http://remote/api/evaluation/v1/turn-evaluations",
      { method: "POST" },
    )))?.status).toBe(405);
    expect((await evaluation.fetch(new Request(
      "http://remote/api/evaluation/v1/turn-evaluations/missing/turn",
    )))?.status).toBe(404);
  });

  it("连续保存一百个 Turn 后按 ID 只读取目标分片", async () => {
    const evaluation = await createEvaluation();
    for (let index = 0; index < 100; index += 1) {
      completeTurn(evaluation, "long-session", `turn-${index}`);
      await evaluation.flush();
    }

    const dir = dirs[0]!;
    expect((await readdir(join(dir, "turn-evaluations"))).filter((name) => name.endsWith(".json")))
      .toHaveLength(100);
    expect(await evaluation.get("long-session", "turn-57"))
      .toMatchObject({ trace: { turnId: "turn-57" } });
  });

  it("人工效果打分与 Runtime 评测事实分开持久化", async () => {
    const evaluation = await createEvaluation();
    const saved = await evaluation.putEffectScore("session", "turn", {
      schemaVersion: 1,
      annotations: {
        understanding: { requirements: [{ requirementId: "prompt-1", label: "保留真实组件", weight: 100, verdict: "met" }], completed: true },
        planning: { score: 76, completed: true },
        output: { score: 82, marks: [], completed: true },
      },
    }, 91, scoreInput());

    expect(saved).toMatchObject({ sessionId: "session", turnId: "turn", executionScore: 91 });
    expect(await evaluation.getEffectScore("session", "turn")).toEqual(saved);
    expect((await readdir(join(dirs[0]!, "turn-effect-scores"))).filter((name) => name.endsWith(".json"))).toHaveLength(1);
    expect(await evaluation.get("session", "turn")).toBeUndefined();
  });

  it("初始化失败时降级但不阻断 Remote，并让查询明确返回 503", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kindergarten-eval-degraded-"));
    dirs.push(dir);
    const file = join(dir, "not-a-directory");
    await writeFile(file, "occupied\n");
    const evaluation = new EvaluationModule(file);

    await expect(evaluation.initialize()).resolves.toBeUndefined();
    expect(evaluation.available).toBe(false);
    expect((await evaluation.fetch(new Request(
      "http://remote/api/evaluation/v1/turn-evaluations/session/turn",
    )))?.status).toBe(503);
    expect(() => completeTurn(evaluation, "session", "turn")).not.toThrow();
  });
});

async function createEvaluation(): Promise<EvaluationModule> {
  const dir = await mkdtemp(join(tmpdir(), "kindergarten-eval-module-"));
  dirs.push(dir);
  const evaluation = new EvaluationModule(dir);
  await evaluation.initialize();
  return evaluation;
}

function scoreInput() {
  return {
    ownerId: "local-admin",
    modelStudentId: "model-1",
    source: { kind: "turn_effect" as const, sessionId: "session", turnId: "turn" },
    sourceTitle: "测试 Turn · 单轮效果打分",
    agentConfiguration: {
      agentSnapshotHash: "snapshot-1",
      agentId: "agent-1",
      agentName: "测试 Agent",
      systemPrompt: "完成任务",
      builtinTools: [], builtinSkills: [], skills: [], mcps: [],
      historyPolicy: { mode: "none" as const },
      memoryPolicy: { mode: "off" as const },
      reasoning: {
        schemaVersion: 1 as const,
        requestedProfile: "balanced" as const,
        resolvedProfile: "balanced" as const,
        source: "model_default" as const,
        providerKind: "fixture",
        model: "fixture-model",
        native: {},
      },
    },
  };
}

function completeTurn(evaluation: EvaluationModule, sessionId: string, turnId: string): void {
  const runId = `${sessionId}:${turnId}`;
  evaluation.emit({
    type: "turn_started",
    runId,
    sessionId,
    turnId,
    startedAt: 1,
    variant: {
      studentId: "student",
      studentName: "Student",
      provider: "ollama",
      model: "qwen3:8b",
      systemPromptHash: "hash",
      runtimeVersion: "1.5",
      toolNames: [],
    },
    resolvedReasoning: {
      schemaVersion: 1,
      requestedProfile: "balanced",
      resolvedProfile: "balanced",
      source: "model_default",
      providerKind: "ollama",
      model: "qwen3:8b",
      native: { think: true },
    },
  });
  evaluation.emit({
    type: "turn_completed",
    runId,
    status: "completed",
    completedAt: 2,
  });
}
