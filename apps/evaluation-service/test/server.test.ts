import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LegacyTurnTraceDocumentV1 } from "@kindergarten/evaluation-contract";
import { EvaluationRepository } from "../src/repository.js";
import { EvaluationServer } from "../src/server.js";
import { normalizeTurnTrace } from "../src/trace-migration.js";
import { evaluateTurn } from "../src/evaluator.js";

const dirs: string[] = [];
afterEach(/** 在每个测试后释放临时资源，保证后续场景从干净状态开始。 */
async () => {
  await Promise.all(dirs.splice(0).map(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(dir) => rm(dir, { recursive: true, force: true })));
});

describe("Evaluation API", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("保存并按 sessionId/turnId 查询完整评测", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const dir = await mkdtemp(join(tmpdir(), "kindergarten-eval-"));
    dirs.push(dir);
    const server = new EvaluationServer(new EvaluationRepository(dir));
    await server.listen("127.0.0.1", 0);
    const address = server.http.address();
    if (!address || typeof address === "string") throw new Error("测试端口不可用");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const response = await fetch(`${base}/api/v1/turn-evaluations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(traceFixture()),
      });
      expect(response.status).toBe(201);
      const loaded = await fetch(`${base}/api/v1/turn-evaluations/session/turn`);
      expect(loaded.status).toBe(200);
      expect(await loaded.json()).toMatchObject({
        trace: { sessionId: "session", turnId: "turn" },
        result: { normallyCompleted: true, modelRoundCount: 0 },
      });
    } finally {
      await server.close();
    }
  });

  it("连续保存一百个 Turn 后按 ID 只读取目标分片", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const dir = await mkdtemp(join(tmpdir(), "kindergarten-eval-100-"));
    dirs.push(dir);
    const repository = new EvaluationRepository(dir);
    for (let index = 0; index < 100; index += 1) {
      const trace = traceFixture();
      trace.sessionId = "long-session";
      trace.turnId = `turn-${index}`;
      trace.traceId = `trace-${index}`;
      trace.runId = `run-${index}`;
      const normalized = normalizeTurnTrace(trace);
      await repository.put({
        schemaVersion: 2,
        trace: normalized,
        result: evaluateTurn(normalized),
        createdAt: new Date(index).toISOString(),
      });
    }

    expect((await readdir(join(dir, "turn-evaluations"))).filter(/** 构造「toHaveLength」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(name) => name.endsWith(".json"))).toHaveLength(100);
    expect(await repository.get("long-session", "turn-57")).toMatchObject({ trace: { turnId: "turn-57" } });
  });
});

/** 构造「traceFixture」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function traceFixture(): LegacyTurnTraceDocumentV1 {
  const resolvedReasoning = {
    schemaVersion: 1 as const,
    requestedProfile: "auto" as const,
    resolvedProfile: "balanced" as const,
    source: "model_default" as const,
    providerKind: "ollama",
    model: "qwen3:8b",
    native: { think: true },
  };
  return {
    schemaVersion: 1,
    traceId: "trace",
    runId: "run",
    sessionId: "session",
    turnId: "turn",
    resolvedReasoning,
    variant: {
      studentId: "student",
      studentName: "Student",
      provider: "ollama",
      model: "qwen3:8b",
      systemPromptHash: "hash",
      runtimeVersion: "1.5",
      toolNames: [],
    },
    status: "completed",
    startedAt: 1,
    completedAt: 2,
    modelRounds: [],
    toolCalls: [],
    permissions: [],
    errors: [],
  };
}
