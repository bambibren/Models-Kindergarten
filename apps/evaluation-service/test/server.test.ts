import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TurnTraceDocument } from "@kindergarten/evaluation-contract";
import { EvaluationRepository } from "../src/repository.js";
import { EvaluationServer } from "../src/server.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Evaluation API", () => {
  it("保存并按 sessionId/turnId 查询完整评测", async () => {
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
});

function traceFixture(): TurnTraceDocument {
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
