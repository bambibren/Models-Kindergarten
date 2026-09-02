import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import {
  CONTEXT_SUMMARY_NOTIFICATION,
  CONTEXT_WINDOW_USAGE_NOTIFICATION,
  EXECUTION_TRACE_NOTIFICATION,
  TOKEN_USAGE_NOTIFICATION,
  TURN_STATE_NOTIFICATION,
  makePromptMeta,
  makeExperimentRunRefMeta,
  makeSessionResumeMeta,
  makeSessionBindingMeta,
  readContextSummaryNotification,
  readContextWindowUsageNotification,
  readLiveExecutionNotification,
  readTokenUsageNotification,
  readTurnStateNotification,
  type ContextSummaryNotification,
  type ContextWindowUsageNotification,
  type LiveExecutionNotification,
  type TokenUsageNotification,
  type TurnStateNotification,
} from "@kindergarten/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { KindergartenAgent } from "../src/acp/kindergarten-agent.js";
import type {
  ModelContextFragment,
  ModelContextSerialization,
  ModelEvent,
  ModelInput,
  ModelProvider,
  ModelStudent,
} from "../src/model/model-provider.js";
import { SessionRepository } from "../src/repository/session-repository.js";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { FileSandbox } from "../src/tools/sandbox.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { ModelProviderError } from "../src/model/model-error.js";
import { SessionBindingService } from "../src/session/session-binding-service.js";
import { ModelStudentCatalog } from "../src/model/model-student-catalog.js";

const tempDirs: string[] = [];

afterEach(/** 在每个测试后释放临时资源，保证后续场景从干净状态开始。 */
async () => {
  await Promise.all(
    tempDirs.splice(0).map(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("ACP 会话语义", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("实验 Session 通过同一 ACP 连接实时发送模型失败与重试轨迹", async () => {
    const events: LiveExecutionNotification[] = [];
    const agent = await makeAgent(new RetryOnceProvider(), undefined, undefined, true);
    const client = await openClient(agent, [], [], [], [], [], events);
    const created = await client.agent.request(acp.methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
      _meta: makeExperimentRunRefMeta("experiment-live", "variant-a"),
    });

    await sendPrompt(client, created.sessionId, "测试实时重试", "turn-live");

    expect(events.map((item) => item.event.type)).toEqual([
      "model_round_started",
      "model_attempt_started",
      "model_attempt_failed",
      "model_attempt_started",
      "model_attempt_completed",
    ]);
    expect(events.map((item) => item.event.sequence)).toEqual([0, 1, 2, 3, 4]);
    expect(events[2]?.event).toMatchObject({
      type: "model_attempt_failed",
      attemptIndex: 0,
      error: { code: "MODEL_TRANSPORT_ERROR", retryable: true },
    });
    expect(events[3]?.event).toMatchObject({ type: "model_attempt_started", attemptIndex: 1 });

    const chat = await client.agent.request(acp.methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
      _meta: testSessionMeta(),
    });
    await sendPrompt(client, chat.sessionId, "普通聊天", "turn-chat");
    expect(events).toHaveLength(5);
  });

  it("load 完整回放，resume 零回放，且连接之间不广播", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const provider = new StaticProvider();
    const agent = await makeAgent(provider);
    const firstUpdates: acp.SessionNotification[] = [];
    const secondUpdates: acp.SessionNotification[] = [];
    const firstSummaries: ContextSummaryNotification[] = [];
    const secondSummaries: ContextSummaryNotification[] = [];
    const firstUsages: TokenUsageNotification[] = [];
    const secondUsages: TokenUsageNotification[] = [];
    const firstWindows: ContextWindowUsageNotification[] = [];
    const secondWindows: ContextWindowUsageNotification[] = [];
    const first = await openClient(agent, firstUpdates, firstSummaries, firstUsages, [], firstWindows);

    // initialize 本身不应产生任何 session/update。
    expect(firstUpdates).toHaveLength(0);
    const created = await first.agent.request(acp.methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
      _meta: testSessionMeta(),
    });
    expect(created.configOptions?.[0]).toMatchObject({
      type: "select",
      id: "reasoning_profile",
      category: "thought_level",
      currentValue: "auto",
    });
    expect(created.configOptions?.[0]?.type === "select" ? created.configOptions[0].options : []).toEqual([
      { value: "auto", name: "跟随模型默认 · 均衡" },
      { value: "balanced", name: "均衡" },
      { value: "deep", name: "深入" },
    ]);
    await expect(first.agent.request(acp.methods.agent.session.setConfigOption, {
      sessionId: created.sessionId,
      configId: "reasoning_profile",
      value: "max",
    })).rejects.toThrow("不支持该思考强度");
    const configured = await first.agent.request(acp.methods.agent.session.setConfigOption, {
      sessionId: created.sessionId,
      configId: "reasoning_profile",
      value: "deep",
    });
    expect(configured.configOptions[0]).toMatchObject({ currentValue: "deep" });
    await sendPrompt(first, created.sessionId, "第一问", "turn-1");
    expect(provider.lastInput?.reasoning).toMatchObject({
      requestedProfile: "deep",
      resolvedProfile: "deep",
      source: "session_override",
      native: { level: "deep" },
    });
    expect(firstSummaries).toHaveLength(1);
    expect(firstSummaries[0]?.summary.items.map(/** 构造「toEqual」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(item) => item.kind)).toEqual([
      "system_instruction",
      "available_tools",
    ]);
    expect(firstSummaries[0]?.summary.items.every(/** 构造「toBe」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(item) => item.raw?.model === "fixture"))
      .toBe(true);
    expect(JSON.stringify(firstSummaries[0])).not.toContain("第一问");
    expect(firstUsages).toHaveLength(1);
    expect(firstUsages[0]?.usage).toMatchObject({
      turnId: "turn-1",
      modelRequests: 1,
      inputTokens: 12,
      outputTokens: 5,
    });
    expect(firstUsages[0]?.usage.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "current_prompt", estimatedTokens: 1 }),
      expect.objectContaining({ category: "answer", estimatedTokens: 2 }),
    ]));
    expect(firstWindows).toEqual([
      expect.objectContaining({
        sessionId: created.sessionId,
        state: expect.objectContaining({
          status: "available",
          afterTurnId: "turn-1",
          windowTokens: 128_000,
          basis: "next_prompt_base",
        }),
      }),
    ]);

    const second = await openClient(agent, secondUpdates, secondSummaries, secondUsages, [], secondWindows);
    const firstCount = firstUpdates.length;
    const loaded = await second.agent.request(acp.methods.agent.session.load, {
      sessionId: created.sessionId,
      cwd: "/workspace",
      mcpServers: [],
    });
    expect(loaded.configOptions?.[0]).toMatchObject({ currentValue: "deep" });

    expect(firstUpdates).toHaveLength(firstCount);
    expect(messageTexts(secondUpdates)).toEqual([
      [expect.any(String), "第一问"],
      [expect.any(String), "第一段第二段"],
    ]);
    expect(secondSummaries).toHaveLength(1);
    expect(secondSummaries[0]?.summary.turnId).toBe("turn-1");
    expect(secondSummaries[0]?.summary).toEqual(firstSummaries[0]?.summary);
    expect(secondUsages).toHaveLength(1);
    expect(secondUsages[0]?.usage).toEqual(firstUsages[0]?.usage);
    expect(secondWindows).toEqual(firstWindows);

    secondUpdates.length = 0;
    secondSummaries.length = 0;
    secondUsages.length = 0;
    secondWindows.length = 0;
    const resumed = await second.agent.request(acp.methods.agent.session.resume, {
      sessionId: created.sessionId,
      cwd: "/workspace",
      mcpServers: [],
    });
    expect(resumed.configOptions?.[0]).toMatchObject({ currentValue: "deep" });
    expect(secondUpdates).toHaveLength(0);
    expect(secondSummaries).toHaveLength(0);
    expect(secondUsages).toHaveLength(0);
    expect(secondWindows).toHaveLength(0);

    firstUpdates.length = 0;
    await sendPrompt(first, created.sessionId, "第二问", "turn-2");
    expect(firstUpdates.length).toBeGreaterThan(0);
    expect(firstSummaries).toHaveLength(2);
    expect(firstWindows).toHaveLength(2);
    expect(firstWindows[1]?.state).toMatchObject({
      status: "available",
      afterTurnId: "turn-2",
      windowTokens: 128_000,
    });
    const historyRaw = firstSummaries[1]?.summary.items.find(
      /** 构造「raw」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(item) => item.kind === "session_history",
    )?.raw?.value;
    expect(historyRaw).toContain("第一问");
    expect(historyRaw).toContain("第一段第二段");
    expect(historyRaw).not.toContain("第二问");
    expect(secondUpdates).toHaveLength(0);
    expect(secondSummaries).toHaveLength(0);
    expect(secondUsages).toHaveLength(0);
    expect(secondWindows).toHaveLength(0);

    await closeClient(first);
    await closeClient(second);
  });

  it("Agent 删除后仍可 load 历史，但新 prompt 在写入 user Turn 前失败", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const provider = new StaticProvider();
    let agentExists = true;
    const agent = await makeAgent(provider, undefined, /** 构造「agent」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => agentExists);
    const firstUpdates: acp.SessionNotification[] = [];
    const first = await openClient(agent, firstUpdates);
    const created = await first.agent.request(acp.methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
      _meta: testSessionMeta(),
    });
    await sendPrompt(first, created.sessionId, "删除前的问题", "turn-before-delete");

    agentExists = false;
    const beforeUpdates: acp.SessionNotification[] = [];
    const before = await openClient(agent, beforeUpdates);
    await before.agent.request(acp.methods.agent.session.load, {
      sessionId: created.sessionId,
      cwd: "/workspace",
      mcpServers: [],
    });
    const historyBeforeRejectedPrompt = messageTexts(beforeUpdates);
    expect(historyBeforeRejectedPrompt.some(/** 构造「toBe」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
([, text]) => text === "删除前的问题")).toBe(true);

    await expect(sendPrompt(first, created.sessionId, "不应写入历史", "turn-after-delete"))
      .rejects.toMatchObject({
        code: -32002,
        data: { code: "SESSION_AGENT_DELETED", retryable: false },
      });
    await expect(sendPrompt(first, created.sessionId, "再次尝试", "turn-after-delete-2"))
      .rejects.toThrow("该会话绑定的 Agent 已删除，不能继续对话");

    const afterUpdates: acp.SessionNotification[] = [];
    const after = await openClient(agent, afterUpdates);
    await after.agent.request(acp.methods.agent.session.load, {
      sessionId: created.sessionId,
      cwd: "/workspace",
      mcpServers: [],
    });
    expect(messageTexts(afterUpdates)).toEqual(historyBeforeRejectedPrompt);
    expect(messageTexts(afterUpdates).some(/** 构造「toBe」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
([, text]) => text === "不应写入历史")).toBe(false);
    await Promise.all([closeClient(first), closeClient(before), closeClient(after)]);
  });

  it("同一 session 同时只允许一轮 prompt，并支持 cancel", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const provider = new WaitingProvider();
    const agent = await makeAgent(provider);
    const updates: acp.SessionNotification[] = [];
    const client = await openClient(agent, updates);
    const created = await client.agent.request(acp.methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
      _meta: testSessionMeta(),
    });
    expect(created.configOptions).toEqual([]);
    await expect(client.agent.request(acp.methods.agent.session.setConfigOption, {
      sessionId: created.sessionId,
      configId: "reasoning_profile",
      value: "deep",
    })).rejects.toThrow("不支持该思考强度");

    const running = sendPrompt(
      client,
      created.sessionId,
      "等待取消",
      "turn-running",
    );
    await expect(client.agent.request(acp.methods.agent.session.setConfigOption, {
      sessionId: created.sessionId,
      configId: "reasoning_profile",
      value: "auto",
    })).rejects.toThrow("回答生成期间不能修改思考强度");
    await provider.started;

    await expect(
      sendPrompt(
        client,
        created.sessionId,
        "并发请求",
        "turn-second",
      ),
    ).rejects.toThrow("已有一轮回答正在生成");

    await client.agent.notify(acp.methods.agent.session.cancel, {
      sessionId: created.sessionId,
    });
    await expect(running).resolves.toMatchObject({ stopReason: "cancelled" });
    await closeClient(client);
  });

  it("WebSocket 断开不取消 Runtime，手动 resume 只补当前 Turn 缺失文本", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const provider = new DisconnectProvider();
    const agent = await makeAgent(provider);
    const firstUpdates: acp.SessionNotification[] = [];
    const firstStates: TurnStateNotification[] = [];
    const firstWindows: ContextWindowUsageNotification[] = [];
    const first = await openClient(agent, firstUpdates, [], [], firstStates, firstWindows);
    const created = await first.agent.request(acp.methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
      _meta: testSessionMeta(),
    });
    const running = sendPrompt(first, created.sessionId, "断线后继续", "turn-resume")
      .then(/** 构造「running」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(value) => value, /** 构造「running」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(error: unknown) => error);
    await provider.firstChunk;
    await waitUntil(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
() => messageTexts(firstUpdates).some(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
([, text]) => text === "第一段"));
    const received = messageTexts(firstUpdates);
    const user = received.find(/** 构造「user」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
([, text]) => text === "断线后继续");
    const assistant = received.find(/** 构造「assistant」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
([, text]) => text === "第一段");
    expect(user).toBeDefined();
    expect(assistant).toBeDefined();

    await closeClient(first);
    provider.continue();
    await provider.completed;
    expect(provider.aborted).toBe(false);
    expect(await running).toBeInstanceOf(Error);

    const resumedUpdates: acp.SessionNotification[] = [];
    const resumedStates: TurnStateNotification[] = [];
    const resumedWindows: ContextWindowUsageNotification[] = [];
    const resumed = await openClient(agent, resumedUpdates, [], [], resumedStates, resumedWindows);
    await resumed.agent.request(acp.methods.agent.session.resume, {
      sessionId: created.sessionId,
      cwd: "/workspace",
      mcpServers: [],
      _meta: makeSessionResumeMeta({
        schemaVersion: 1,
        turnId: "turn-resume",
        messages: {
          [user![0]]: { textLength: "断线后继续".length, nextChunkIndex: 1 },
          [assistant![0]]: { textLength: "第一段".length, nextChunkIndex: 1 },
        },
        thoughts: {},
      }),
    });

    expect(messageTexts(resumedUpdates)).toEqual([[assistant![0], "第二段"]]);
    await waitUntil(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
() => resumedStates.some(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(item) => item.turn.status === "completed"));
    expect(resumedStates.at(-1)?.turn).toEqual({
      schemaVersion: 1,
      turnId: "turn-resume",
      status: "completed",
    });
    expect(resumedWindows).toEqual([
      expect.objectContaining({
        sessionId: created.sessionId,
        state: expect.objectContaining({
          status: "available",
          afterTurnId: "turn-resume",
          windowTokens: 128_000,
        }),
      }),
    ]);
    await closeClient(resumed);
  });

  it("session/close 取消当前 Turn 但不关闭 ACP 连接或删除历史", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const provider = new WaitingProvider();
    const agent = await makeAgent(provider);
    const client = await openClient(agent, []);
    const created = await client.agent.request(acp.methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
      _meta: testSessionMeta(),
    });
    const running = sendPrompt(client, created.sessionId, "离开页面", "turn-close");
    await provider.started;

    await client.agent.request(acp.methods.agent.session.close, { sessionId: created.sessionId });
    await expect(running).resolves.toMatchObject({ stopReason: "cancelled" });
    await expect(client.agent.request(acp.methods.agent.session.list, { cwd: "/workspace" }))
      .resolves.toMatchObject({ sessions: [expect.objectContaining({ sessionId: created.sessionId })] });
    await closeClient(client);
  });

  it("Prompt 致命错误只通过 JSON-RPC error 保留具体原因", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const client = await openClient(await makeAgent(new FailedProvider()), []);
    const created = await client.agent.request(acp.methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
      _meta: testSessionMeta(),
    });
    try {
      await sendPrompt(client, created.sessionId, "触发依赖错误", "turn-failed");
      throw new Error("预期 Prompt 失败");
    } catch (error) {
      expect(error).toBeInstanceOf(acp.RequestError);
      expect((error as acp.RequestError).code).toBe(-32001);
      expect((error as acp.RequestError).message).toContain("Ollama 不可用");
      expect((error as acp.RequestError).data).toBeUndefined();
    }
    await closeClient(client);
  });

  it("Session Config 从该 Session 绑定的 ModelStudent 读取推理能力", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const fallback = new StaticProvider();
    const selected = new MaxReasoningProvider();
    const models = new ModelStudentCatalog(fallback, "ready");
    models.register(selected, { initialStatus: "ready" });
    const client = await openClient(await makeAgent(fallback, models), []);
    const created = await client.agent.request(acp.methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
      _meta: testSessionMeta(selected.student.id),
    });
    const options = created.configOptions?.[0]?.type === "select" ? created.configOptions[0].options : [];
    expect(options.map(/** 构造「toEqual」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(item) => "value" in item ? item.value : item.group)).toEqual(["auto", "fast", "balanced", "deep", "max"]);
    await expect(client.agent.request(acp.methods.agent.session.setConfigOption, {
      sessionId: created.sessionId,
      configId: "reasoning_profile",
      value: "max",
    })).resolves.toMatchObject({ configOptions: [expect.objectContaining({ currentValue: "max" })] });
    await closeClient(client);
  });
});

class StaticProvider implements ModelProvider {
  readonly student = testStudent;
  readonly reasoningCapability: import("@kindergarten/contracts").ModelReasoningCapability = {
    schemaVersion: 1 as const,
    control: "effort_levels" as const,
    adjustable: true,
    supportedProfiles: ["balanced", "deep"],
    defaultProfile: "balanced" as const,
  };
  /** 构造「nativeReasoning」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
nativeReasoning(profile: "balanced" | "deep") { return { level: profile }; }
  lastInput?: ModelInput;
  /** 构造「serializeContext」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
serializeContext(fragment: ModelContextFragment): ModelContextSerialization {
    return serializeTestContext(this.student, fragment);
  }
  /** 构造「stream」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async *stream(input: ModelInput): AsyncIterable<ModelEvent> {
    this.lastInput = structuredClone(input);
    yield { type: "output_item_started", item: { id: "capture-message", kind: "message" } };
    yield { type: "output_item_delta", itemId: "capture-message", delta: { kind: "text", text: "第一段" } };
    yield { type: "output_item_delta", itemId: "capture-message", delta: { kind: "text", text: "第二段" } };
    yield { type: "output_item_completed", item: { id: "capture-message", kind: "message", text: "第一段第二段" } };
    yield { type: "usage", inputTokens: 12, outputTokens: 5 };
    yield { type: "finish", reason: "stop" };
  }
}

class WaitingProvider implements ModelProvider {
  readonly student = testStudent;
  readonly reasoningCapability: import("@kindergarten/contracts").ModelReasoningCapability = {
    schemaVersion: 1,
    control: "fixed",
    adjustable: false,
    supportedProfiles: ["balanced"],
    defaultProfile: "balanced",
  };
  /** 构造「serializeContext」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
serializeContext(fragment: ModelContextFragment): ModelContextSerialization {
    return serializeTestContext(this.student, fragment);
  }
  private start!: () => void;
  readonly started = new Promise<void>(/** 构造「started」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(resolve) => {
    this.start = resolve;
  });

  /** 构造「stream」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async *stream(
    _input: ModelInput,
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent> {
    this.start();
    await new Promise<void>(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(_resolve, reject) => {
      const cancel = /** 构造「cancel」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => reject(new DOMException("已取消", "AbortError"));
      if (signal.aborted) cancel();
      else signal.addEventListener("abort", cancel, { once: true });
    });
    if (false) yield { type: "finish", reason: "cancelled" };
  }
}

class DisconnectProvider implements ModelProvider {
  readonly student = testStudent;
  private release!: () => void;
  private first!: () => void;
  private done!: () => void;
  readonly firstChunk = new Promise<void>(/** 构造「firstChunk」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(resolve) => { this.first = resolve; });
  readonly completed = new Promise<void>(/** 构造「completed」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(resolve) => { this.done = resolve; });
  readonly waiting = new Promise<void>(/** 构造「waiting」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(resolve) => { this.release = resolve; });
  aborted = false;

  /** 构造「serializeContext」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
serializeContext(fragment: ModelContextFragment): ModelContextSerialization {
    return serializeTestContext(this.student, fragment);
  }
  /** 构造「continue」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
continue(): void { this.release(); }
  /** 构造「stream」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async *stream(_input: ModelInput, signal: AbortSignal): AsyncIterable<ModelEvent> {
    signal.addEventListener("abort", /** 构造「stream」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => { this.aborted = true; }, { once: true });
    yield { type: "output_item_started", item: { id: "disconnect-message", kind: "message" } };
    yield { type: "output_item_delta", itemId: "disconnect-message", delta: { kind: "text", text: "第一段" } };
    this.first();
    await this.waiting;
    yield { type: "output_item_delta", itemId: "disconnect-message", delta: { kind: "text", text: "第二段" } };
    yield { type: "output_item_completed", item: { id: "disconnect-message", kind: "message", text: "第一段第二段" } };
    yield { type: "finish", reason: "stop" };
    this.done();
  }
}

class FailedProvider implements ModelProvider {
  readonly student = testStudent;
  /** 构造「serializeContext」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
serializeContext(fragment: ModelContextFragment): ModelContextSerialization {
    return serializeTestContext(this.student, fragment);
  }
  /** 构造「stream」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async *stream(): AsyncIterable<ModelEvent> {
    throw new ModelProviderError("dependency_unavailable", "Ollama 不可用", false);
  }
}

class RetryOnceProvider implements ModelProvider {
  readonly student = testStudent;
  private attempts = 0;
  serializeContext(fragment: ModelContextFragment): ModelContextSerialization {
    return serializeTestContext(this.student, fragment);
  }
  async *stream(): AsyncIterable<ModelEvent> {
    this.attempts += 1;
    if (this.attempts === 1) {
      throw new ModelProviderError("dependency_unavailable", "Provider 连接中断", true, { retryAfterMs: 0 });
    }
    yield { type: "output_item_started", item: { id: "retry-message", kind: "message" } };
    yield { type: "output_item_delta", itemId: "retry-message", delta: { kind: "text", text: "重试成功" } };
    yield { type: "output_item_completed", item: { id: "retry-message", kind: "message", text: "重试成功" } };
    yield { type: "finish", reason: "stop" };
  }
}

class MaxReasoningProvider implements ModelProvider {
  readonly student: ModelStudent = {
    ...testStudent,
    id: "responses-student",
    name: "大聪明",
    provider: { kind: "openai-compatible", baseUrl: "https://api.example.test/v1", model: "gpt-5.5" },
  };
  readonly reasoningCapability: import("@kindergarten/contracts").ModelReasoningCapability = {
    schemaVersion: 1,
    control: "effort_levels",
    adjustable: true,
    supportedProfiles: ["fast", "balanced", "deep", "max"],
    defaultProfile: "balanced",
  };
  /** 构造「serializeContext」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
serializeContext(fragment: ModelContextFragment): ModelContextSerialization {
    return serializeTestContext(this.student, fragment);
  }
  /** 构造「stream」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async *stream(): AsyncIterable<ModelEvent> { yield { type: "finish", reason: "stop" }; }
}

/** 构造「serializeTestContext」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function serializeTestContext(
  student: ModelStudent,
  fragment: ModelContextFragment,
): ModelContextSerialization {
  const value = fragment.kind === "system"
    ? { role: "system", content: fragment.content }
    : fragment.kind === "tools"
      ? fragment.tools
      : fragment.kind === "messages"
        ? fragment.messages
        : { sent: false, sourceIds: fragment.sourceIds };
  return {
    provider: student.provider.kind,
    model: student.provider.model,
    format: "json",
    value: JSON.stringify(value, null, 2),
  };
}

/** 构造「makeAgent」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async function makeAgent(
  provider: ModelProvider,
  models?: ModelStudentCatalog,
  agentExists: ((id: string) => boolean | Promise<boolean>) | undefined = undefined,
  experimentBinding = false,
): Promise<acp.AgentApp> {
  const dir = await mkdtemp(join(tmpdir(), "kindergarten-"));
  tempDirs.push(dir);
  const sessions = new SessionRepository(dir);
  const sandbox = new FileSandbox(join(dir, "sandbox"));
  await sandbox.initialize();
  const modelCatalog = models ?? new ModelStudentCatalog(provider, "ready");
  return new KindergartenAgent(
    sessions,
    AgentRuntime.fromRegistry(provider, new ToolRegistry(sandbox)),
    new SessionBindingService({
      workspaceCwd: "/workspace",
      agentExists: agentExists ?? ((id) => id === "agent-1"),
      modelStudentReady: /** 构造「modelStudentReady」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(id) => modelCatalog.isReady(id),
      experimentBinding: /** 构造「experimentBinding」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => experimentBinding ? { modelStudentId: "student-1", agentId: "agent-1" } : undefined,
    }),
    undefined,
    modelCatalog,
  ).createApp();
}

/** 构造「testSessionMeta」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function testSessionMeta(modelStudentId = "student-1"): Record<string, unknown> {
  return makeSessionBindingMeta({ schemaVersion: 1, modelStudentId, agentId: "agent-1" });
}

/** 构造「openClient」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async function openClient(
  agent: acp.AgentApp,
  updates: acp.SessionNotification[],
  summaries: ContextSummaryNotification[] = [],
  usages: TokenUsageNotification[] = [],
  turns: TurnStateNotification[] = [],
  windows: ContextWindowUsageNotification[] = [],
  executions: LiveExecutionNotification[] = [],
): Promise<acp.ClientConnection> {
  const app = acp
    .client({ name: "test-client" })
    .onNotification(acp.methods.client.session.update, /** 构造「onNotification」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
({ params }) => {
      updates.push(params);
    })
    .onNotification(
      CONTEXT_SUMMARY_NOTIFICATION,
      readContextSummaryNotification,
      /** 构造「onNotification」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
({ params }) => {
        summaries.push(params);
      },
    )
    .onNotification(
      TOKEN_USAGE_NOTIFICATION,
      readTokenUsageNotification,
      /** 构造「onNotification」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
({ params }) => {
        usages.push(params);
      },
    )
    .onNotification(
      TURN_STATE_NOTIFICATION,
      readTurnStateNotification,
      /** 构造「onNotification」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
({ params }) => {
        turns.push(params);
      },
    )
    .onNotification(
      CONTEXT_WINDOW_USAGE_NOTIFICATION,
      readContextWindowUsageNotification,
      /** 构造「app」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
({ params }) => {
        windows.push(params);
      },
    )
    .onNotification(
      EXECUTION_TRACE_NOTIFICATION,
      readLiveExecutionNotification,
      ({ params }) => {
        executions.push(params);
      },
    );
  const connection = app.connect(agent);
  await connection.agent.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {},
  });
  return connection;
}

/** 构造「sendPrompt」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function sendPrompt(
  client: acp.ClientConnection,
  sessionId: string,
  text: string,
  turnId: string,
): Promise<acp.PromptResponse> {
  return client.agent.request(acp.methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "text", text }],
    _meta: makePromptMeta({
      schemaVersion: 1,
      turnId,
    }),
  });
}

const testStudent: ModelStudent = {
  id: "student-1",
  name: "Test Student",
  sizeClass: "large",
  provider: { kind: "ollama", model: "fixture", baseUrl: "http://127.0.0.1" },
  contextWindowTokens: 128_000,
  generationDefaults: {},
};

/** 构造「messageTexts」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function messageTexts(
  updates: acp.SessionNotification[],
): Array<[string, string]> {
  return updates.flatMap(/** 构造「messageTexts」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(notice) => {
    const update = notice.update;
    if (
      (update.sessionUpdate !== "user_message_chunk" &&
        update.sessionUpdate !== "agent_message_chunk") ||
      update.content.type !== "text" ||
      !update.messageId
    ) {
      return [];
    }
    return [[update.messageId, update.content.text] as [string, string]];
  });
}

/** 构造「closeClient」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async function closeClient(client: acp.ClientConnection): Promise<void> {
  client.close();
  await client.closed;
}

/** 构造「waitUntil」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(resolve) => setTimeout(resolve, 5));
  }
  throw new Error("等待 ACP 更新超时");
}
