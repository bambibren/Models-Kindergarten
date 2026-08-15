import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeCapabilityResolver } from "../../src/capability/runtime-capability-resolver.js";
import { ContextPreviewService } from "../../src/experiments/context-preview-service.js";
import { SessionRepository } from "../../src/repository/session-repository.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("ContextPreviewService", () => {
  it("拒绝用其他 ModelStudent 的历史 Turn 生成 Provider 输入预览", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mk-context-preview-"));
    dirs.push(dir);
    const sessions = new SessionRepository(dir);
    const source = await sessions.create({
      cwd: "/workspace",
      ownerId: "local-admin",
      purpose: "chat",
      modelStudentId: "source-student",
      agentId: "source-agent",
    });
    await sessions.startTurn(source.id, "source-turn");
    await sessions.transitionTurn(source.id, "source-turn", "finalizing");
    await sessions.finishTurn(source.id, "source-turn", "completed");
    const buildObserved = vi.fn();
    const resolver = {
      preview: vi.fn(async () => ({
        model: { student: { id: "target-student" } },
        context: { buildObserved },
      })),
    } as unknown as RuntimeCapabilityResolver;
    const service = new ContextPreviewService(resolver, sessions);

    await expect(service.preview({
      modelStudentId: "target-student",
      promptText: "继续",
      policy: {},
      sourceTurnId: "source-turn",
    })).rejects.toMatchObject({
      status: 409,
      code: "EXPERIMENT_NOT_RUNNABLE",
      retryable: false,
      fieldErrors: [{ path: "modelStudentId" }],
    });
    expect(buildObserved).not.toHaveBeenCalled();
  });
});
