import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { noopRuntimeObservationSink } from "@kindergarten/runtime-observation";
import {
  makePromptMeta,
  makeSessionBindingMeta,
  type AgentRecord,
  type ProviderCapabilitySnapshot,
} from "@kindergarten/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KindergartenAgent } from "../../src/acp/kindergarten-agent.js";
import { ContextAssembler } from "../../src/conversation/context-assembler.js";
import type { WritableSecretStore } from "../../src/mcp/secret-store.js";
import type { SecretRef } from "../../src/mcp/mcp-types.js";
import { FixtureProvider } from "../../src/model/fixture-provider.js";
import { ModelAdmissionAdapterRegistry } from "../../src/model/model-admission-adapter-registry.js";
import { ModelAdmissionRepository } from "../../src/model/model-admission-repository.js";
import { ModelAdmissionService } from "../../src/model/model-admission-service.js";
import { ModelProviderPresetRegistry } from "../../src/model/model-provider-preset-registry.js";
import { ModelStudentCatalog } from "../../src/model/model-student-catalog.js";
import { RemoteModelUrlPolicy } from "../../src/model/remote-model-url-policy.js";
import { ResponsesAdmissionAdapter } from "../../src/model/responses-admission-adapter.js";
import { ResponsesApiProvider } from "../../src/model/responses-api-provider.js";
import { SessionRepository } from "../../src/repository/session-repository.js";
import { AgentRuntime } from "../../src/runtime/agent-runtime.js";
import { SessionBindingService } from "../../src/session/session-binding-service.js";
import { FileSandbox } from "../../src/tools/sandbox.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import { ToolRuntime } from "../../src/tools/tool-runtime.js";

const dirs: string[] = [];

afterEach(/** 在每个测试后释放临时资源，保证后续场景从干净状态开始。 */
async () => {
  vi.unstubAllGlobals();
  await Promise.all(dirs.splice(0).map(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(dir) => rm(dir, { recursive: true, force: true })));
});

describe("model admission -> ACP reasoning integration", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("安装出的动态 Responses 模型按自身 max 默认发出 xhigh，并把落档写入 Turn", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const dir = await mkdtemp(join(tmpdir(), "mk-admission-acp-"));
    dirs.push(dir);
    const secrets = new MemorySecrets();
    const fallback = new FixtureProvider();
    const models = new ModelStudentCatalog(fallback, "ready");
    const repository = new ModelAdmissionRepository(
      join(dir, "model-tests.json"),
      join(dir, "model-catalog.json"),
    );
    const policy = new RemoteModelUrlPolicy(/** 构造「policy」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => [{ address: "8.8.8.8", family: 4 }]);
    const responses = new ResponsesAdmissionAdapter(
      { probe: /** 构造「probe」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => maxSnapshot() },
      /** 构造「responses」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(student, connection) => new ResponsesApiProvider({
        id: student.modelStudentId,
        name: student.displayName,
        sizeClass: student.sizeClass,
        provider: {
          kind: "openai-compatible",
          baseUrl: connection.baseUrl,
          model: student.model,
        },
        generationDefaults: { reasoningProfile: student.generationDefaults.reasoningProfile },
      }, {
        readBearerToken: /** 构造「readBearerToken」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => secrets.read(connection.credentialRef!),
        reasoning: {
          capability: student.snapshot.reasoning.capability,
          efforts: Object.fromEntries(Object.entries(student.snapshot.reasoning.nativeByProfile)
            .flatMap(/** 构造「efforts」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
([profile, native]) => typeof native?.effort === "string" ? [[profile, native.effort]] : [])),
        },
      }),
    );
    const adapters = new ModelAdmissionAdapterRegistry([
      responses,
      {
        protocol: "openai_chat_completions",
        adapterRevision: "unused-chat-v1",
        probeVersion: 1,
        probe: /** 构造「probe」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => { throw new Error("unused"); },
        createProvider: /** 构造「createProvider」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => { throw new Error("unused"); },
      },
    ]);
    const admission = new ModelAdmissionService(
      repository,
      secrets,
      adapters,
      new ModelProviderPresetRegistry(adapters),
      models,
      policy,
    );

    const tested = await admission.test({
      presetId: "custom_responses",
      displayName: "大聪明",
      baseUrl: "https://models.example.test/v1",
      model: "vendor-model",
      apiKey: "secret-sentinel",
    });
    const installed = await admission.install({
      testId: tested.testId,
      defaultReasoningProfile: "max",
    });

    const requestBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
async (_url: URL, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const terminal = {
        type: "response.completed",
        response: {
          id: "resp-acp",
          status: "completed",
          output: [{ type: "message", id: "msg-acp", role: "assistant", content: [{ type: "output_text", text: "完成" }] }],
          usage: { input_tokens: 12, output_tokens: 3 },
          reasoning: { effort: "xhigh" },
        },
      };
      return new Response([
        `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "完成" })}\n\n`,
        `event: response.completed\ndata: ${JSON.stringify(terminal)}\n\n`,
      ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
    }));

    const sessions = new SessionRepository(dir, {
      ownerId: "local-admin",
      modelStudentId: installed.modelStudentId,
      agentId: "agent-1",
    });
    const sandbox = new FileSandbox(join(dir, "sandbox"));
    await sandbox.initialize();
    const tools = new ToolRuntime(new ToolRegistry(sandbox));
    const agent = agentRecord();
    const runtime = new AgentRuntime(
      fallback,
      tools,
      new ContextAssembler(),
      noopRuntimeObservationSink,
      {
        resolve: /** 构造「resolve」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async (scope) => ({
          scope,
          agent,
          agentSnapshotHash: "a".repeat(64),
          model: models.requireProvider(scope.modelStudentId),
          tools,
          context: new ContextAssembler(),
          fileSandbox: sandbox,
          capabilityHash: "b".repeat(64),
        }),
      },
    );
    const app = new KindergartenAgent(
      sessions,
      runtime,
      new SessionBindingService({
        workspaceCwd: "/workspace",
        agentExists: /** 构造「agentExists」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(id) => id === agent.agentId,
        modelStudentReady: /** 构造「modelStudentReady」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(id) => models.isReady(id),
        experimentBinding: /** 构造「experimentBinding」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => undefined,
      }),
      undefined,
      models,
    ).createApp();
    const client = acp.client({ name: "admission-acp-test" }).connect(app);
    await client.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const created = await client.agent.request(acp.methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
      _meta: makeSessionBindingMeta({
        schemaVersion: 1,
        modelStudentId: installed.modelStudentId,
        agentId: agent.agentId,
      }),
    });
    expect(created.configOptions?.[0]?.type === "select" ? created.configOptions[0].options[0] : undefined)
      .toEqual({ value: "auto", name: "跟随模型默认 · 极致" });
    await client.agent.request(acp.methods.agent.session.prompt, {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "测试极致推理" }],
      _meta: makePromptMeta({ schemaVersion: 1, turnId: "turn-admission-acp" }),
    });

    expect(requestBodies).toHaveLength(1);
    expect(requestBodies[0]).toMatchObject({
      model: "vendor-model",
      reasoning: { effort: "xhigh", summary: "auto" },
      stream: true,
      store: false,
    });
    const stored = await sessions.get(created.sessionId);
    expect(stored.turns[0]?.resolvedReasoning).toMatchObject({
      requestedProfile: "auto",
      resolvedProfile: "max",
      source: "model_default",
      native: { effort: "xhigh" },
    });
    client.close();
    await client.closed;
  });
});

class MemorySecrets implements WritableSecretStore {
  private readonly values = new Map<string, string>();
  /** 构造「read」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async read(ref: SecretRef): Promise<string> {
    const value = this.values.get(ref.key);
    if (!value) throw new Error("missing secret");
    return value;
  }
  /** 构造「write」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async write(ref: SecretRef, value: string): Promise<void> { this.values.set(ref.key, value); }
  /** 构造「delete」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async delete(ref: SecretRef): Promise<void> { this.values.delete(ref.key); }
}

/** 构造「agentRecord」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function agentRecord(): AgentRecord {
  return {
    schemaVersion: 1,
    agentId: "agent-1",
    ownerId: "local-admin",
    recordKind: "user",
    name: "测试 Agent",
    systemPrompt: "你是测试助手。",
    builtinTools: [],
    skills: [],
    mcps: [],
    historyPolicy: { mode: "none" },
    memoryPolicy: { mode: "off" },
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
  };
}

/** 构造「maxSnapshot」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function maxSnapshot(): ProviderCapabilitySnapshot {
  return {
    schemaVersion: 1,
    protocol: "openai_responses",
    adapterRevision: "openai-responses-v1",
    probeVersion: 1,
    connectionFingerprint: "c".repeat(64),
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
