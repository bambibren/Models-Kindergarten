import { randomUUID } from "node:crypto";
import type { ToolCallStatus } from "@agentclientprotocol/sdk";
import { ContextBuilder } from "../conversation/context-builder.js";
import type { ModelProvider, ModelToolCall } from "../model/model-provider.js";
import type { SessionEntry } from "../repository/session-types.js";
import { toRunFailure } from "./run-failure.js";
import {
  ToolCallLedger,
  ToolRuntime,
} from "../tools/tool-runtime.js";
import type {
  PreparedToolCall,
  ToolOutcome,
  ToolRegistry,
} from "../tools/tool-registry.js";

export interface RunInput {
  text: string;
  sessionEntries: SessionEntry[];
}

export interface RunObserver {
  text(round: number, value: string): Promise<void>;
  thought(round: number, value: string): Promise<void>;
  roundComplete(round: number): Promise<void>;
  toolStart(call: PreparedToolCall): Promise<void>;
  toolFinish(call: PreparedToolCall, status: ToolCallStatus, result: ToolOutcome): Promise<void>;
  requestPermission(call: PreparedToolCall): Promise<boolean>;
  askUser(question: string, toolCallId: string): Promise<string>;
}

export interface RunResult {
  runId: string;
  reason: "stop" | "length" | "cancelled";
}

/** AgentRuntime 聚合完整能力；AgentRunner 只执行一次 session/prompt。 */
export class AgentRuntime {
  readonly runner: AgentRunner;

  constructor(
    readonly model: ModelProvider,
    readonly tools: ToolRuntime,
    context = new ContextBuilder(),
  ) {
    this.runner = new AgentRunner(model, tools, context);
  }

  static fromRegistry(model: ModelProvider, registry: ToolRegistry): AgentRuntime {
    return new AgentRuntime(model, new ToolRuntime(registry));
  }

  run(input: RunInput, observer: RunObserver, signal: AbortSignal): Promise<RunResult> {
    return this.runner.run(input, observer, signal);
  }
}

export class AgentRunner {
  constructor(
    private readonly model: ModelProvider,
    private readonly tools: ToolRuntime,
    private readonly context: ContextBuilder,
  ) {}

  async run(input: RunInput, observer: RunObserver, signal: AbortSignal): Promise<RunResult> {
    const runId = randomUUID();
    const messages = this.context.build(input.sessionEntries, input.text);
    const ledger = new ToolCallLedger();

    for (let round = 0; ; round += 1) {
      let content = "";
      let thinking = "";
      let reason: "stop" | "length" | "cancelled" = "stop";
      const calls = new Map<string, ModelToolCall>();

      try {
        for await (const event of this.model.stream(
          { messages, tools: this.tools.registry.definitions },
          signal,
        )) {
          if (event.type === "text_delta") {
            content += event.text;
            await observer.text(round, event.text);
          } else if (event.type === "thinking_delta") {
            thinking += event.text;
            await observer.thought(round, event.text);
          } else if (event.type === "tool_calls") {
            for (const call of event.calls) calls.set(toolCallKey(call), call);
          } else if (event.type === "finish") {
            reason = event.reason;
          }
        }
      } catch (error) {
        if (isAbort(error) || signal.aborted) return { runId, reason: "cancelled" };
        // 模型流无法继续时才提升为 Turn 级失败；具体错误文本保持不变。
        throw toRunFailure(error);
      }

      await observer.roundComplete(round);
      const modelCalls = [...calls.values()];
      if (modelCalls.length === 0) return { runId, reason };

      const prepared = modelCalls.map((call, index) =>
        prepareCall(this.tools.registry, call, `${randomUUID()}:${index}`),
      );
      messages.push({
        role: "assistant",
        content,
        ...(thinking ? { thinking } : {}),
        toolCalls: prepared.map(({ modelCall, call }) => ({
          id: call.id,
          name: modelCall.name,
          arguments: modelCall.arguments,
        })),
      });

      let batch;
      try {
        batch = await this.tools.executeBatch(
          prepared.map((item) => item.call),
          observer,
          ledger,
          signal,
        );
      } catch (error) {
        if (isAbort(error) || signal.aborted) return { runId, reason: "cancelled" };
        // ToolRuntime 正常会把工具失败收敛为 ToolOutcome；到达这里说明执行链本身已中断。
        throw toRunFailure(error);
      }
      for (let index = 0; index < prepared.length; index += 1) {
        const item = prepared[index];
        const outcome = batch.outcomes[index];
        if (!item || !outcome) continue;
        messages.push({
          role: "tool",
          toolName: item.call.name,
          toolCallId: item.call.id,
          content: outcome.modelContent,
        });
      }
    }
  }
}

function prepareCall(
  registry: ToolRegistry,
  modelCall: ModelToolCall,
  fallbackId: string,
): { modelCall: ModelToolCall; call: PreparedToolCall } {
  try {
    return { modelCall, call: registry.prepare(modelCall, fallbackId) };
  } catch (error) {
    const message = errorText(error);
    return {
      modelCall,
      call: {
        id: fallbackId,
        name: modelCall.name,
        title: `无效工具调用：${modelCall.name}`,
        kind: "other",
        arguments: modelCall.arguments,
        permission: "allow",
        locations: [],
        dedupeKey: `${modelCall.name}:${JSON.stringify(modelCall.arguments)}`,
        retry: "none",
        validationError: message,
      },
    };
  }
}

function toolCallKey(call: ModelToolCall): string {
  if (call.id) return call.id;
  if (call.index !== undefined) return `index:${call.index}`;
  return `${call.name}:${JSON.stringify(call.arguments)}`;
}

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
