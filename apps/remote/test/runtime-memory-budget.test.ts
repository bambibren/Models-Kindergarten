import { describe, expect, it } from "vitest";
import { PRODUCT_CONFIG, type RuntimeExecutionBudget } from "@kindergarten/contracts";
import type { RuntimeCapabilitySnapshot } from "../src/capability/capability-types.js";
import { ContextAssembler } from "../src/conversation/context-assembler.js";
import type {
  ModelContextFragment,
  ModelContextSerialization,
  ModelEvent,
  ModelProvider,
  ModelStudent,
  ModelToolCall,
} from "../src/model/model-provider.js";
import { noopRuntimeObservationSink } from "@kindergarten/runtime-observation";
import {
  AgentRuntime,
  RuntimeTurnAdmission,
  type RunObserver,
} from "../src/runtime/agent-runtime.js";
import type {
  PreparedToolCall,
  ToolExecutionContext,
  ToolRegistryPort,
  ToolResult,
} from "../src/tools/tool-registry.js";
import { ToolCallLedger, ToolRuntime, type ToolObserver } from "../src/tools/tool-runtime.js";

const observer: RunObserver = {
  context: /** 构造「context」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => undefined,
  text: /** 构造「text」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => undefined,
  thought: /** 构造「thought」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => undefined,
  roundComplete: /** 构造「roundComplete」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => undefined,
  toolStart: /** 构造「toolStart」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => undefined,
  toolFinish: /** 构造「toolFinish」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => undefined,
  requestPermission: /** 构造「requestPermission」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => true,
  askUser: /** 构造「askUser」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => "",
};

const toolObserver: ToolObserver = {
  toolStart: /** 构造「toolStart」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => undefined,
  toolFinish: /** 构造「toolFinish」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => undefined,
  requestPermission: /** 构造「requestPermission」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => true,
  askUser: /** 构造「askUser」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async () => "",
};

describe("Runtime 有界内存预算", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("正文超过单轮字节上限时结构化失败并释放 Turn 准入名额", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const admission = new RuntimeTurnAdmission();
    const budget = smallBudget({ maxTextBytesPerRound: 3, maxConcurrentTurns: 1 });
    const runtime = new AgentRuntime(
      new EventProvider([{ type: "text_delta", text: "四五" }]),
      new ToolRuntime(new FixtureRegistry()),
      new ContextAssembler(),
      noopRuntimeObservationSink,
      undefined,
      budget,
      admission,
    );

    await expect(runtime.run(
      { text: "测试正文上限", sessionEntries: [] },
      observer,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "MODEL_TEXT_BYTES_LIMIT", retryable: false });
    expect(admission.activeTurns).toBe(0);
  });

  it("同一进程达到并发上限时拒绝新 Turn，release 重复调用也只释放一次", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const admission = new RuntimeTurnAdmission();
    const release = admission.acquire(1);
    expect(release).toBeTypeOf("function");
    expect(admission.acquire(1)).toBeUndefined();
    release?.();
    release?.();
    expect(admission.activeTurns).toBe(0);
    expect(admission.acquire(1)).toBeTypeOf("function");
  });

  it("工具结果超过统一视图上限时丢弃整份结果并返回小型失败", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const registry = new FixtureRegistry(PRODUCT_CONFIG.tools.maxResultViewBytes + 1);
    const call = registry.prepare({ name: "fixture", arguments: {} }, "call-1");
    const result = await new ToolRuntime(registry).executeBatch(
      [call],
      toolObserver,
      new ToolCallLedger(),
      new AbortController().signal,
    );

    expect(result.outcomes[0]).toMatchObject({
      status: "error",
      error: { code: "tool_result_too_large", category: "resource_limit" },
    });
    expect(JSON.stringify(result.outcomes[0])).not.toContain("x".repeat(512));
  });

  it("一个工具批次最多并行四项且结果顺序与模型调用顺序一致", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const registry = new FixtureRegistry(0, 10);
    const calls = Array.from({ length: 9 }, /** 构造「calls」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(_value, index) =>
      registry.prepare({ name: "fixture", arguments: { index } }, `call-${index}`));
    const result = await new ToolRuntime(registry).executeBatch(
      calls,
      toolObserver,
      new ToolCallLedger(),
      new AbortController().signal,
    );

    expect(registry.maxActive).toBe(PRODUCT_CONFIG.tools.maxBatchConcurrency);
    expect(result.outcomes.map(/** 构造「toEqual」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(item) => (item.rawOutput as { index: number }).index))
      .toEqual(Array.from({ length: 9 }, /** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(_value, index) => index));
  });
});

/** 用局部覆盖生成完整预算，避免测试遗漏新增预算字段。 */
function smallBudget(overrides: Partial<RuntimeExecutionBudget>): RuntimeExecutionBudget {
  return { ...PRODUCT_CONFIG.runtime, ...overrides };
}

/** 按给定事件脚本输出 Provider 流，便于精确触发每个预算边界。 */
class EventProvider implements ModelProvider {
  readonly student: ModelStudent = {
    id: "budget-fixture",
    name: "Budget Fixture",
    sizeClass: "large",
    provider: { kind: "ollama", model: "fixture", baseUrl: "http://127.0.0.1" },
    generationDefaults: {},
  };

  /** 构造「EventProvider」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
constructor(private readonly events: ModelEvent[]) {}

  /** 构造「serializeContext」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
serializeContext(fragment: ModelContextFragment): ModelContextSerialization {
    return {
      provider: "ollama",
      model: "fixture",
      format: "json",
      value: JSON.stringify(fragment),
    };
  }

  /** 构造「stream」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async *stream(): AsyncIterable<ModelEvent> {
    yield* this.events;
  }
}

/** 返回可控大小和延时结果的最小 Tool Registry。 */
class FixtureRegistry implements ToolRegistryPort {
  readonly definitions = [{
    type: "function" as const,
    function: {
      name: "fixture",
      description: "测试工具",
      parameters: { type: "object" as const },
    },
  }];
  active = 0;
  maxActive = 0;

  /** 构造「FixtureRegistry」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
constructor(
    private readonly outputBytes = 0,
    private readonly delayMs = 0,
  ) {}

  /** 构造「prepare」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
prepare(call: ModelToolCall, fallbackId: string): PreparedToolCall {
    return {
      id: call.id ?? fallbackId,
      name: call.name,
      title: "fixture",
      kind: "other",
      arguments: structuredClone(call.arguments),
      permission: "allow",
      locations: [],
      dedupeKey: fallbackId,
      retry: "none",
    };
  }

  /** 构造「execute」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async execute(call: PreparedToolCall, _context: ToolExecutionContext): Promise<ToolResult> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.delayMs) await new Promise(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(resolve) => setTimeout(resolve, this.delayMs));
      const rawOutput = this.outputBytes > 0
        ? { value: "x".repeat(this.outputBytes) }
        : { index: Number(call.arguments.index ?? 0) };
      return {
        modelContent: JSON.stringify(rawOutput),
        rawOutput,
        content: [],
        locations: [],
      };
    } finally {
      this.active -= 1;
    }
  }

  /** 构造「capabilitySnapshot」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
capabilitySnapshot(): RuntimeCapabilitySnapshot {
    return { tools: [], mcpServers: [], skills: [] };
  }
}
