import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionRepository } from "../../src/repository/session-repository.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("Session reasoning persistence", () => {
  it("同一个 Repository 实例顺序修改时最后一次配置完整持久化", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mk-reasoning-session-"));
    dirs.push(dir);
    const repository = new SessionRepository(dir);
    const session = await repository.create({
      cwd: "/workspace",
      ownerId: "local-admin",
      purpose: "chat",
      modelStudentId: "student-1",
      agentId: "agent-1",
    });
    await repository.setReasoningOverride(session.id, "deep");
    await repository.setReasoningOverride(session.id, "max");
    expect(await repository.get(session.id)).toMatchObject({ reasoningOverride: "max", revision: 2 });
  });
});
