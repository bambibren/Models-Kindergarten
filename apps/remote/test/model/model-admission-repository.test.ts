import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderCapabilitySnapshot } from "@kindergarten/contracts";
import { ModelAdmissionRepository } from "../../src/model/model-admission-repository.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("ModelAdmissionRepository", () => {
  it("原子保存 Connection + ModelStudent，且公开 Connection 不泄漏 credentialRef", async () => {
    const dir = await tempDir();
    const catalogFile = join(dir, "catalog.json");
    const repository = new ModelAdmissionRepository(join(dir, "tests.json"), catalogFile);
    const connection = connectionRecord();
    const student = studentRecord();

    await repository.install(connection, student);
    expect(await repository.installed()).toEqual([{ connection, student }]);
    expect(repository.connectionView(connection)).not.toHaveProperty("credentialRef");
    const persisted = await readFile(catalogFile, "utf8");
    expect(persisted).toContain("models-kindergarten/provider-connections/connection-1");
    expect(persisted).not.toContain("super-secret");
  });

  it("拒绝归属不一致的聚合，并在最后一个学生删除时一起移除 Connection", async () => {
    const dir = await tempDir();
    const repository = new ModelAdmissionRepository(join(dir, "tests.json"), join(dir, "catalog.json"));
    await expect(repository.install(connectionRecord(), { ...studentRecord(), connectionId: "other" }))
      .rejects.toThrow("归属不一致");
    await repository.install(connectionRecord(), studentRecord());
    const removed = await repository.removeStudent("student-1", "local-admin");
    expect(removed?.removedConnection?.connectionId).toBe("connection-1");
    expect(await repository.installed()).toEqual([]);
  });

  it("测试记录只持久化公开候选，不接受 apiKey 字段", async () => {
    const dir = await tempDir();
    const testsFile = join(dir, "tests.json");
    const repository = new ModelAdmissionRepository(testsFile, join(dir, "catalog.json"));
    await repository.putTest({
      schemaVersion: 1,
      testId: "test-1",
      ownerId: "local-admin",
      candidate: { presetId: "custom_responses", displayName: "大聪明", baseUrl: "https://api.example.test/v1", model: "gpt-x", protocol: "openai_responses" },
      state: "succeeded",
      snapshot: capabilitySnapshot(),
      createdAt: "2026-08-14T00:00:00.000Z",
      expiresAt: "2026-08-14T00:15:00.000Z",
    });
    expect(await readFile(testsFile, "utf8")).not.toContain("apiKey");
  });

  it("在同一次原子 catalog update 内拒绝重复 testId 和重复 endpoint/model", async () => {
    const dir = await tempDir();
    const repository = new ModelAdmissionRepository(join(dir, "tests.json"), join(dir, "catalog.json"));
    const firstStudent = { ...studentRecord(), lifecycle: "active" as const, installationTestId: "test-1" };
    await repository.install(connectionRecord(), firstStudent);
    await expect(repository.install(
      { ...connectionRecord(), connectionId: "connection-2", baseUrl: "https://other.example.test/v1" },
      { ...firstStudent, modelStudentId: "student-2", connectionId: "connection-2", model: "gpt-y" },
    )).rejects.toMatchObject({ reason: "duplicate_test" });
    await expect(repository.install(
      { ...connectionRecord(), connectionId: "connection-3" },
      { ...firstStudent, modelStudentId: "student-3", connectionId: "connection-3", installationTestId: "test-3" },
    )).rejects.toMatchObject({ reason: "duplicate_model" });
    expect(await repository.listStudents()).toHaveLength(1);
  });

  it("持久化安装生命周期迁移", async () => {
    const dir = await tempDir();
    const repository = new ModelAdmissionRepository(join(dir, "tests.json"), join(dir, "catalog.json"));
    await repository.install(connectionRecord(), { ...studentRecord(), lifecycle: "installing", installationTestId: "test-1" });
    expect((await repository.setLifecycle("student-1", "local-admin", "active")).lifecycle).toBe("active");
    expect((await repository.getStudent("student-1"))?.lifecycle).toBe("active");
  });

  it("安全读取旧 custom Responses 记录并补齐 preset 与协议中立 reasoning", async () => {
    const dir = await tempDir();
    const catalogFile = join(dir, "catalog.json");
    const connection = connectionRecord();
    const { presetId: _presetId, ...legacyConnection } = connection;
    const { generationDefaults: _generationDefaults, ...legacyStudent } = studentRecord();
    const current = capabilitySnapshot();
    const legacySnapshot = {
      schemaVersion: 1,
      protocol: "openai_responses",
      streaming: current.streaming,
      text: current.text,
      toolCalls: current.toolCalls,
      toolContinuation: current.toolContinuation,
      usage: current.usage,
      thought: current.thought,
      reasoning: {
        capability: current.reasoning.capability,
        efforts: { fast: "low", balanced: "medium", deep: "high", max: "xhigh" },
        acceptedEfforts: ["low", "medium", "high", "xhigh"],
      },
      testedAt: current.testedAt,
    };
    await writeFile(catalogFile, JSON.stringify({ schemaVersion: 1, records: [
      legacyConnection,
      { ...legacyStudent, snapshot: legacySnapshot },
    ] }), "utf8");

    const repository = new ModelAdmissionRepository(join(dir, "tests.json"), catalogFile);
    const [installed] = await repository.installed();
    expect(installed?.connection.presetId).toBe("custom_responses");
    expect(installed?.student.snapshot).toMatchObject({
      adapterRevision: "openai-responses-legacy-v1",
      connectionFingerprint: "legacy-unverified",
      reasoning: { nativeByProfile: { max: { effort: "xhigh" } } },
    });
    expect(installed?.student.generationDefaults).toEqual({ reasoningProfile: "balanced" });
    await repository.persistMigrations();
    const migrated = JSON.parse(await readFile(catalogFile, "utf8")) as { records: Array<Record<string, unknown>> };
    expect(migrated.records[1]).toMatchObject({ generationDefaults: { reasoningProfile: "balanced" } });
  });
});

function connectionRecord() {
  return {
    schemaVersion: 1 as const,
    recordKind: "provider_connection" as const,
    connectionId: "connection-1",
    ownerId: "local-admin",
    presetId: "custom_responses" as const,
    protocol: "openai_responses" as const,
    baseUrl: "https://api.example.test/v1",
    credentialRef: { provider: "keychain" as const, key: "models-kindergarten/provider-connections/connection-1" },
    credentialHint: "••••cret",
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
  };
}

function studentRecord() {
  return {
    schemaVersion: 1 as const,
    recordKind: "model_student" as const,
    modelStudentId: "student-1",
    ownerId: "local-admin",
    connectionId: "connection-1",
    displayName: "大聪明",
    model: "gpt-x",
    sizeClass: "large" as const,
    generationDefaults: { reasoningProfile: "balanced" as const },
    snapshot: capabilitySnapshot(),
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
  };
}

function capabilitySnapshot(): ProviderCapabilitySnapshot {
  return {
    schemaVersion: 1 as const,
    protocol: "openai_responses" as const,
    adapterRevision: "openai-responses-v1",
    probeVersion: 1,
    connectionFingerprint: "a".repeat(64),
    streaming: true,
    text: true,
    toolCalls: true,
    toolContinuation: true,
    usage: true,
    thought: true,
    reasoning: {
      capability: {
        schemaVersion: 1 as const,
        control: "effort_levels" as const,
        adjustable: true,
        supportedProfiles: ["fast", "balanced", "deep", "max"],
        defaultProfile: "balanced" as const,
        native: { parameter: "reasoning.effort", values: ["low", "medium", "high", "xhigh"] },
      },
      nativeByProfile: {
        fast: { effort: "low" }, balanced: { effort: "medium" },
        deep: { effort: "high" }, max: { effort: "xhigh" },
      },
      acceptedNativeValues: [
        { effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" },
      ],
    },
    testedAt: "2026-08-14T00:00:00.000Z",
  };
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mk-model-admission-repository-"));
  dirs.push(dir);
  return dir;
}
