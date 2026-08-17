import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ProviderCapabilitySnapshot,
  ResolvedModelStudentCandidate,
  ResponsesModelCandidateInput,
} from "@kindergarten/contracts";
import type { SecretRef } from "../../src/mcp/mcp-types.js";
import type { WritableSecretStore } from "../../src/mcp/secret-store.js";
import { ModelAdmissionRepository } from "../../src/model/model-admission-repository.js";
import { ModelAdmissionService } from "../../src/model/model-admission-service.js";
import { ModelAdmissionAdapterRegistry } from "../../src/model/model-admission-adapter-registry.js";
import { ModelProviderPresetRegistry } from "../../src/model/model-provider-preset-registry.js";
import { ModelStudentCatalog } from "../../src/model/model-student-catalog.js";
import { FixtureProvider } from "../../src/model/fixture-provider.js";
import { RemoteModelUrlPolicy } from "../../src/model/remote-model-url-policy.js";
import { ResponsesApiProvider } from "../../src/model/responses-api-provider.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("ModelAdmissionService", () => {
  it("OpenAI 固定预设由 Remote 解析官方地址，并以 preset/protocol 持久化", async () => {
    const setup = await environment();
    const tested = await setup.service.test({
      presetId: "openai",
      displayName: "官方模型",
      model: "gpt-x",
      apiKey: "secret",
    });
    expect(tested.candidate).toMatchObject({
      presetId: "openai",
      protocol: "openai_responses",
      baseUrl: "https://api.openai.com/v1",
    });
    expect(setup.prober.seen?.baseUrl).toBe("https://api.openai.com/v1");
    const installed = await setup.service.install({ testId: tested.testId });
    const student = await setup.repository.getStudent(installed.modelStudentId);
    const connection = student ? await setup.repository.getConnection(student.connectionId) : undefined;
    expect(tested).not.toHaveProperty("contextWindowTokens");
    expect(installed).not.toHaveProperty("contextWindowTokens");
    expect(student).not.toHaveProperty("contextWindowTokens");
    expect(connection).toMatchObject({ presetId: "openai", protocol: "openai_responses" });
  });

  it("硅基流动固定预设走 Chat Completions 适配器且不能落成 Responses 快照", async () => {
    const setup = await environment();
    const tested = await setup.service.test({
      presetId: "siliconflow",
      displayName: "硅基模型",
      model: "vendor/model",
      apiKey: "secret",
    });
    expect(tested).toMatchObject({
      state: "succeeded",
      candidate: {
        presetId: "siliconflow",
        protocol: "openai_chat_completions",
        baseUrl: "https://api.siliconflow.cn/v1",
      },
      snapshot: { protocol: "openai_chat_completions" },
    });
  });

  it("按 test → install 两阶段入园，明文 Key 不落盘，能力来自真实 probe 快照", async () => {
    const setup = await environment();
    const raw = candidate();
    const tested = await setup.service.test(raw);

    expect(tested.state).toBe("succeeded");
    expect(JSON.stringify(tested)).not.toContain(raw.apiKey);
    expect(setup.prober.seen?.apiKey).toBe(raw.apiKey);
    expect(await readFile(setup.testsFile, "utf8")).not.toContain(raw.apiKey);

    expect(tested).not.toHaveProperty("contextWindowTokens");
    const installed = await setup.service.install({
      testId: tested.testId,
      displayName: "大聪明",
      contextWindowTokens: 1_050_000,
    });
    expect(installed).toMatchObject({
      displayName: "大聪明",
      providerKind: "openai-compatible",
      status: "ready",
      deletable: true,
      contextWindowTokens: 1_050_000,
      supports: { toolCalls: true },
    });
    expect(installed.supports.reasoning.supportedProfiles).toEqual(["fast", "balanced", "deep", "max"]);
    const provider = setup.catalog.requireProvider(installed.modelStudentId);
    expect(provider.student.contextWindowTokens).toBe(1_050_000);
    expect(provider.nativeReasoning?.("max")).toEqual({ effort: "xhigh" });
    expect(setup.secrets.values.size).toBe(1);
    expect(await readFile(setup.catalogFile, "utf8")).not.toContain(raw.apiKey);
    expect(await setup.repository.getStudent(installed.modelStudentId)).toMatchObject({
      contextWindowTokens: 1_050_000,
    });

    const restoredCatalog = new ModelStudentCatalog(new FixtureProvider(), "ready");
    const restoredService = serviceFor(
      setup.repository,
      setup.secrets,
      setup.prober,
      restoredCatalog,
      setup.policy,
    );
    await expect(restoredService.restoreInstalled()).resolves.toEqual([
      expect.objectContaining({ contextWindowTokens: 1_050_000 }),
    ]);
    expect(restoredCatalog.requireProvider(installed.modelStudentId).student.contextWindowTokens)
      .toBe(1_050_000);
  });

  it("安装时单独保存用户选择的模型默认档位，不改写体检快照", async () => {
    const setup = await environment();
    const tested = await setup.service.test(candidate());
    const installed = await setup.service.install({
      testId: tested.testId,
      defaultReasoningProfile: "max",
    });
    expect(installed.supports.reasoning.defaultProfile).toBe("max");
    const stored = await setup.repository.getStudent(installed.modelStudentId);
    expect(stored?.generationDefaults.reasoningProfile).toBe("max");
    expect(stored?.snapshot.reasoning.capability.defaultProfile).toBe("balanced");
    const provider = setup.catalog.requireProvider(installed.modelStudentId);
    expect(provider.student.generationDefaults.reasoningProfile).toBe("max");
    expect(provider.reasoningCapability?.defaultProfile).toBe("balanced");
  });

  it("拒绝体检未支持的默认推理档位", async () => {
    const setup = await environment({ probe: async () => limitedResponsesCapabilitySnapshot() });
    const tested = await setup.service.test(candidate());
    await expect(setup.service.install({
      testId: tested.testId,
      defaultReasoningProfile: "max",
    })).rejects.toMatchObject({ code: "VALIDATION_FAILED", retryable: false });
    expect(await setup.repository.listStudents()).toHaveLength(0);
  });

  it("失败记录会清除瞬时 Key，并从上游错误中脱敏", async () => {
    const setup = await environment({
      probe: async (input) => { throw new Error(`upstream echoed Bearer ${input.apiKey}`); },
    });
    const raw = candidate();
    const tested = await setup.service.test(raw);
    expect(tested.state).toBe("failed");
    expect(tested.error?.code).toBe("MODEL_CONNECTION_FAILED");
    expect(tested.error?.message).not.toContain(raw.apiKey);
    await expect(setup.service.install({ testId: tested.testId })).rejects.toMatchObject({ code: "MODEL_PROBE_EXPIRED" });
  });

  it("服务重启后不能用无明文 Key 的旧 probe 安装，但已安装模型可从 Keychain 引用恢复", async () => {
    const setup = await environment();
    const tested = await setup.service.test(candidate());

    const restartedCatalog = new ModelStudentCatalog(new FixtureProvider(), "ready");
    const restartedBeforeInstall = serviceFor(setup.repository, setup.secrets, setup.prober, restartedCatalog, setup.policy);
    await expect(restartedBeforeInstall.install({ testId: tested.testId })).rejects.toMatchObject({ code: "MODEL_PROBE_EXPIRED" });

    const installed = await setup.service.install({ testId: tested.testId });
    const afterInstallCatalog = new ModelStudentCatalog(new FixtureProvider(), "ready");
    const restarted = serviceFor(setup.repository, setup.secrets, setup.prober, afterInstallCatalog, setup.policy);
    await restarted.restoreInstalled();
    expect(afterInstallCatalog.isReady(installed.modelStudentId)).toBe(true);
    expect(afterInstallCatalog.requireProvider(installed.modelStudentId).student.name).toBe("大聪明");
  });

  it("保护内置模型，并阻止删除仍被 Session 引用的用户模型", async () => {
    let inUseId: string | undefined;
    const setup = await environment({ modelInUse: (id) => id === inUseId });
    await expect(setup.service.remove("fixture-student")).rejects.toMatchObject({ code: "CONFLICT" });

    const tested = await setup.service.test(candidate());
    const installed = await setup.service.install({ testId: tested.testId });
    inUseId = installed.modelStudentId;
    await expect(setup.service.remove(installed.modelStudentId)).rejects.toMatchObject({ code: "MODEL_IN_USE" });
    inUseId = undefined;
    setup.secrets.failDelete = true;
    await expect(setup.service.remove(installed.modelStudentId)).rejects.toMatchObject({ code: "MODEL_CONNECTION_FAILED" });
    expect(setup.catalog.get(installed.modelStudentId)).toBeDefined();
    expect(await setup.repository.getStudent(installed.modelStudentId)).toBeDefined();
    setup.secrets.failDelete = false;
    await expect(setup.service.remove(installed.modelStudentId)).resolves.toEqual({ modelStudentId: installed.modelStudentId });
    expect(setup.catalog.get(installed.modelStudentId)).toBeUndefined();
    expect(setup.secrets.values.size).toBe(0);
  });

  it.each(["x", "xy", "xyz", "wxyz"])("1-4 字符 Key 的 credentialHint 不包含任何原文: %s", async (apiKey) => {
    const setup = await environment();
    const tested = await setup.service.test(candidate(apiKey));
    const installed = await setup.service.install({ testId: tested.testId });
    const stored = await setup.repository.getStudent(installed.modelStudentId);
    const connection = stored ? await setup.repository.getConnection(stored.connectionId) : undefined;
    expect(connection?.credentialHint).toBe("••••");
    expect(connection?.credentialHint).not.toContain(apiKey);
  });

  it("原子 claim 阻止同一 testId 并发双安装", async () => {
    const setup = await environment();
    const tested = await setup.service.test(candidate());
    const first = setup.service.install({ testId: tested.testId });
    const second = setup.service.install({ testId: tested.testId });
    await expect(second).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(first).resolves.toMatchObject({ displayName: "大聪明", status: "ready" });
    expect(await setup.repository.listStudents()).toHaveLength(1);
    expect(setup.secrets.values.size).toBe(1);
  });

  it("安装失败释放 claim；清理成功后同一 probe 可以重试", async () => {
    const setup = await environment();
    const tested = await setup.service.test(candidate());
    setup.secrets.failWrite = true;
    await expect(setup.service.install({ testId: tested.testId })).rejects.toMatchObject({ code: "MODEL_CONNECTION_FAILED" });
    expect(await setup.repository.listStudents()).toHaveLength(0);
    setup.secrets.failWrite = false;
    await expect(setup.service.install({ testId: tested.testId })).resolves.toMatchObject({ status: "ready" });
  });

  it("安装与 Keychain 回滚同时失败时持久化 rollback_pending，启动时不会恢复为可用模型", async () => {
    const setup = await environment();
    const tested = await setup.service.test(candidate());
    setup.secrets.failWrite = true;
    setup.secrets.failDelete = true;
    await expect(setup.service.install({ testId: tested.testId })).rejects.toMatchObject({ code: "MODEL_CONNECTION_FAILED" });
    const pending = (await setup.repository.listStudents())[0];
    expect(pending?.lifecycle).toBe("rollback_pending");

    const restartCatalog = new ModelStudentCatalog(new FixtureProvider(), "ready");
    const restarted = serviceFor(setup.repository, setup.secrets, setup.prober, restartCatalog, setup.policy);
    const restored = await restarted.restoreInstalled();
    expect(restored).toEqual([expect.objectContaining({ status: "unavailable", statusMessage: expect.stringContaining("回滚") })]);
    expect(restartCatalog.isReady(pending?.modelStudentId ?? "")).toBe(false);

    setup.secrets.failDelete = false;
    const cleanCatalog = new ModelStudentCatalog(new FixtureProvider(), "ready");
    await serviceFor(setup.repository, setup.secrets, setup.prober, cleanCatalog, setup.policy).restoreInstalled();
    expect(await setup.repository.listStudents()).toHaveLength(0);
  });

  it("崩溃停在 installing 且 Secret 不存在时，重启自动回滚并允许重新入园", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mk-model-admission-installing-recovery-"));
    dirs.push(dir);
    const repository = new ModelAdmissionRepository(join(dir, "tests.json"), join(dir, "catalog.json"));
    const pair = persistedPair("crashed", "test-crashed", "2026-08-14T00:00:00.000Z");
    await repository.install(pair.connection, { ...pair.student, lifecycle: "installing" });
    const secrets = new MemorySecrets();
    const prober = new FakeProber(async () => capabilitySnapshot());
    const catalog = new ModelStudentCatalog(new FixtureProvider(), "ready");
    const policy = new RemoteModelUrlPolicy(async () => [{ address: "8.8.8.8" }]);

    expect(await serviceFor(repository, secrets, prober, catalog, policy).restoreInstalled()).toEqual([]);
    expect(await repository.listStudents()).toEqual([]);

    const restarted = serviceFor(repository, secrets, prober, catalog, policy);
    const tested = await restarted.test(candidate());
    await expect(restarted.install({ testId: tested.testId })).resolves.toMatchObject({ status: "ready" });
  });

  it("启动 reconciliation 只允许一份同 endpoint/model 记录 ready，其余明确隔离", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mk-model-admission-reconcile-"));
    dirs.push(dir);
    const testsFile = join(dir, "tests.json");
    const catalogFile = join(dir, "catalog.json");
    const first = persistedPair("one", "test-one", "2026-08-14T00:00:00.000Z");
    const duplicate = persistedPair("two", "test-two", "2026-08-14T00:01:00.000Z");
    await writeFile(catalogFile, JSON.stringify({ schemaVersion: 1, records: [
      first.connection, first.student, duplicate.connection, duplicate.student,
    ] }), "utf8");
    const repository = new ModelAdmissionRepository(testsFile, catalogFile);
    const secrets = new MemorySecrets();
    secrets.values.set(first.connection.credentialRef.key, "secret-one");
    secrets.values.set(duplicate.connection.credentialRef.key, "secret-two");
    const catalog = new ModelStudentCatalog(new FixtureProvider(), "ready");
    const policy = new RemoteModelUrlPolicy(async () => [{ address: "8.8.8.8" }]);
    const service = serviceFor(repository, secrets, new FakeProber(async () => capabilitySnapshot()), catalog, policy);

    const restored = await service.restoreInstalled();
    expect(restored).toHaveLength(2);
    expect(restored.filter((item) => item.status === "ready")).toHaveLength(1);
    expect(restored.filter((item) => item.status === "unavailable")).toEqual([
      expect.objectContaining({ statusMessage: expect.stringContaining("重复入园") }),
    ]);
  });

  it("凭据已删除但 JSON 删除失败时保留 deleting 日志，重启继续完成删除", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mk-model-admission-delete-recovery-"));
    dirs.push(dir);
    const repository = new FailOnceRemoveRepository(join(dir, "tests.json"), join(dir, "catalog.json"));
    const secrets = new MemorySecrets();
    const prober = new FakeProber(async () => capabilitySnapshot());
    const catalog = new ModelStudentCatalog(new FixtureProvider(), "ready");
    const policy = new RemoteModelUrlPolicy(async () => [{ address: "8.8.8.8" }]);
    const service = serviceFor(repository, secrets, prober, catalog, policy);
    const tested = await service.test(candidate());
    const installed = await service.install({ testId: tested.testId });

    repository.failRemove = true;
    await expect(service.remove(installed.modelStudentId)).rejects.toMatchObject({ code: "MODEL_CONNECTION_FAILED" });
    expect(secrets.values.size).toBe(0);
    expect((await repository.getStudent(installed.modelStudentId))?.lifecycle).toBe("deleting");
    expect(catalog.get(installed.modelStudentId)?.status).toBe("unavailable");

    repository.failRemove = false;
    const restartedCatalog = new ModelStudentCatalog(new FixtureProvider(), "ready");
    await serviceFor(repository, secrets, prober, restartedCatalog, policy).restoreInstalled();
    expect(await repository.listStudents()).toHaveLength(0);
    expect(restartedCatalog.all()).toHaveLength(1);
  });
});

class MemorySecrets implements WritableSecretStore {
  readonly values = new Map<string, string>();
  failWrite = false;
  failDelete = false;
  async read(ref: SecretRef): Promise<string> {
    const value = this.values.get(ref.key);
    if (!value) throw new Error("missing");
    return value;
  }
  async write(ref: SecretRef, value: string): Promise<void> {
    if (this.failWrite) throw new Error("keychain write failed");
    this.values.set(ref.key, value);
  }
  async delete(ref: SecretRef): Promise<void> {
    if (this.failDelete) throw new Error("keychain locked");
    this.values.delete(ref.key);
  }
}

class FakeProber {
  seen?: ResponsesModelCandidateInput;
  constructor(private readonly run: (input: ResponsesModelCandidateInput) => Promise<ProviderCapabilitySnapshot>) {}
  async probe(input: ResponsesModelCandidateInput): Promise<ProviderCapabilitySnapshot> {
    this.seen = structuredClone(input);
    return this.run(input);
  }
}

class FailOnceRemoveRepository extends ModelAdmissionRepository {
  failRemove = false;
  override async removeStudent(modelStudentId: string, ownerId: string) {
    if (this.failRemove) throw new Error("injected catalog delete failure");
    return super.removeStudent(modelStudentId, ownerId);
  }
}

async function environment(options: {
  probe?: (input: ResponsesModelCandidateInput) => Promise<ProviderCapabilitySnapshot>;
  modelInUse?: (id: string) => boolean;
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "mk-model-admission-service-"));
  dirs.push(dir);
  const testsFile = join(dir, "tests.json");
  const catalogFile = join(dir, "catalog.json");
  const repository = new ModelAdmissionRepository(testsFile, catalogFile);
  const secrets = new MemorySecrets();
  const prober = new FakeProber(options.probe ?? (async () => capabilitySnapshot()));
  const catalog = new ModelStudentCatalog(new FixtureProvider(), "ready");
  const policy = new RemoteModelUrlPolicy(async () => [{ address: "8.8.8.8" }]);
  const service = serviceFor(repository, secrets, prober, catalog, policy, options.modelInUse);
  return { dir, testsFile, catalogFile, repository, secrets, prober, catalog, policy, service };
}

function serviceFor(
  repository: ModelAdmissionRepository,
  secrets: MemorySecrets,
  prober: FakeProber,
  catalog: ModelStudentCatalog,
  policy: RemoteModelUrlPolicy,
  modelInUse?: (id: string) => boolean,
) {
  const createResponses = (student: Parameters<ModelAdmissionAdapterRegistry["createProvider"]>[0], connection: Parameters<ModelAdmissionAdapterRegistry["createProvider"]>[1]) => new ResponsesApiProvider({
    id: student.modelStudentId,
    name: student.displayName,
    sizeClass: student.sizeClass,
    ...(student.contextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: student.contextWindowTokens }),
    provider: { kind: "openai-compatible", model: student.model, baseUrl: connection.baseUrl },
    generationDefaults: { reasoningProfile: student.generationDefaults.reasoningProfile },
  }, {
    readBearerToken: () => secrets.read(connection.credentialRef),
    reasoning: {
      capability: student.snapshot.reasoning.capability,
      efforts: responseEfforts(student.snapshot),
    },
    endpointResolver: (url) => policy.resolve(url),
  });
  const adapters = new ModelAdmissionAdapterRegistry([
    {
      protocol: "openai_responses",
      adapterRevision: "openai-responses-v1",
      probeVersion: 1,
      probe: (candidate: ResolvedModelStudentCandidate) => prober.probe(candidate),
      createProvider: createResponses,
    },
    {
      protocol: "openai_chat_completions",
      adapterRevision: "test-chat-v1",
      probeVersion: 1,
      probe: async () => chatCapabilitySnapshot(),
      createProvider: () => { throw new Error("unused test adapter"); },
    },
  ]);
  return new ModelAdmissionService(
    repository,
    secrets,
    adapters,
    new ModelProviderPresetRegistry(adapters),
    catalog,
    policy,
    { ...(modelInUse ? { modelInUse } : {}) },
  );
}

function candidate(apiKey = "sk-test-super-secret"): ResponsesModelCandidateInput {
  return {
    displayName: "大聪明",
    baseUrl: "https://api.example.test/v1",
    model: "gpt-5.5",
    apiKey,
  };
}

function persistedPair(suffix: string, installationTestId: string, createdAt: string) {
  const connectionId = `connection-${suffix}`;
  const connection = {
    schemaVersion: 1 as const,
    recordKind: "provider_connection" as const,
    connectionId,
    ownerId: "local-admin",
    presetId: "custom_responses" as const,
    protocol: "openai_responses" as const,
    baseUrl: "https://api.example.test/v1",
    credentialRef: { provider: "keychain" as const, key: `models-kindergarten/provider-connections/${connectionId}` },
    credentialHint: "••••cret",
    createdAt,
    updatedAt: createdAt,
  };
  const student = {
    schemaVersion: 1 as const,
    recordKind: "model_student" as const,
    modelStudentId: `student-${suffix}`,
    ownerId: "local-admin",
    connectionId,
    displayName: `Student ${suffix}`,
    model: "gpt-5.5",
    sizeClass: "large" as const,
    lifecycle: "active" as const,
    installationTestId,
    generationDefaults: { reasoningProfile: "balanced" as const },
    snapshot: capabilitySnapshot(),
    createdAt,
    updatedAt: createdAt,
  };
  return { connection, student };
}

function capabilitySnapshot(): ProviderCapabilitySnapshot {
  return {
    schemaVersion: 1,
    protocol: "openai_responses",
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
        schemaVersion: 1,
        control: "effort_levels",
        adjustable: true,
        supportedProfiles: ["fast", "balanced", "deep", "max"],
        defaultProfile: "balanced",
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

function responseEfforts(snapshot: ProviderCapabilitySnapshot) {
  return Object.fromEntries(Object.entries(snapshot.reasoning.nativeByProfile)
    .flatMap(([profile, native]) => typeof native?.effort === "string" ? [[profile, native.effort]] : []));
}

function limitedResponsesCapabilitySnapshot(): ProviderCapabilitySnapshot {
  return {
    ...capabilitySnapshot(),
    reasoning: {
      capability: {
        schemaVersion: 1,
        control: "toggle",
        adjustable: true,
        supportedProfiles: ["fast", "balanced"],
        defaultProfile: "balanced",
        native: { parameter: "reasoning.effort", values: ["none", "medium"] },
      },
      nativeByProfile: {
        fast: { effort: "none" },
        balanced: { effort: "medium" },
      },
      acceptedNativeValues: [{ effort: "none" }, { effort: "medium" }],
    },
  };
}

function chatCapabilitySnapshot(): ProviderCapabilitySnapshot {
  return {
    ...capabilitySnapshot(),
    protocol: "openai_chat_completions",
    adapterRevision: "test-chat-v1",
    reasoning: {
      capability: {
        schemaVersion: 1,
        control: "toggle",
        adjustable: true,
        supportedProfiles: ["fast", "balanced"],
        defaultProfile: "balanced",
        native: { parameter: "enable_thinking", values: [false, true] },
      },
      nativeByProfile: {
        fast: { enable_thinking: false },
        balanced: { enable_thinking: true },
      },
      acceptedNativeValues: [
        { enable_thinking: false }, { enable_thinking: true },
      ],
    },
  };
}
