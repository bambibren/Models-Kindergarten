import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LegacyOllamaMigration } from "../../src/model/legacy-ollama-migration.js";
import { ModelAdmissionRepository } from "../../src/model/model-admission-repository.js";

describe("LegacyOllamaMigration", () => {
  it("只在历史 Session 引用时以原 ID 幂等转换成普通 Ollama 记录", async () => {
    const repository = await makeRepository();
    const migration = new LegacyOllamaMigration(repository, (id) => id === "local-coder-student");

    await expect(migration.migrate({
      OLLAMA_URL: "http://127.0.0.1:11434",
      OLLAMA_MODEL: "qwen3:8b",
    })).resolves.toBe(true);
    await expect(migration.migrate({})).resolves.toBe(false);

    expect(await repository.getStudent("local-coder-student")).toMatchObject({
      modelStudentId: "local-coder-student",
      lifecycle: "active",
      sizeClass: "small",
      model: "qwen3:8b",
    });
    expect((await repository.listConnections())[0]).toMatchObject({
      presetId: "ollama",
      protocol: "ollama_native",
    });
  });

  it("新安装没有旧 Session 时保持零模型", async () => {
    const repository = await makeRepository();
    await expect(new LegacyOllamaMigration(repository, () => false).migrate({})).resolves.toBe(false);
    expect(await repository.listStudents()).toEqual([]);
  });
});

async function makeRepository(): Promise<ModelAdmissionRepository> {
  const dir = await mkdtemp(join(tmpdir(), "mk-legacy-ollama-"));
  return new ModelAdmissionRepository(join(dir, "tests.json"), join(dir, "catalog.json"));
}
