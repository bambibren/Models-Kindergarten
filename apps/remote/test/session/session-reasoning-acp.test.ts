import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionRepository } from "../../src/repository/session-repository.js";

const dirs: string[] = [];
afterEach(/** 在每个测试后释放临时资源，保证后续场景从干净状态开始。 */
async () => Promise.all(dirs.splice(0).map(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(dir) => rm(dir, { recursive: true, force: true }))));

describe("Session reasoning persistence", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("同一个 Repository 实例顺序修改时最后一次配置完整持久化", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
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
