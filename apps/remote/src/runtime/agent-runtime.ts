import { randomUUID } from "node:crypto";
import type { ToolCallStatus } from "@agentclientprotocol/sdk";
import type {
  ModelMessage,
  ModelProvider,
  ModelToolCall,
} from "../model/model-provider.js";
import type { StoredEntry } from "../repository/session-types.js";
import {
  ToolRegistry,
  type PreparedToolCall,
  type ToolResult,
} from "../tools/tool-registry.js";

const MAX_MODEL_ROUNDS = 8;

export interface RunInput {
  text: string;
  history: StoredEntry[];
}

export interface RunObserver {
  text(round: number, value: string): Promise<void>;
  thought(round: number, value: string): Promise<void>;
  roundComplete(round: number): Promise<void>;
  toolStart(call: PreparedToolCall): Promise<void>;
  toolFinish(
    call: PreparedToolCall,
    status: ToolCallStatus,
    result: ToolResult | { modelContent: string; rawOutput: unknown },
  ): Promise<void>;
  requestWritePermission(call: PreparedToolCall): Promise<boolean>;
  askUser(question: string, toolCallId: string): Promise<string>;
}

export interface RunResult {
  reason: "stop" | "length" | "cancelled";
}

/**
 * 一轮 ACP Prompt 内可以包含多次模型调用。每批 Tool 先全部占位，再并行执行；
 * 交互请求由 Client 排队展示，因此 Tool 完成顺序不会破坏聊天投影顺序。
 */
export class AgentRuntime {
  constructor(
    readonly model: ModelProvider,
    readonly tools: ToolRegistry,
  ) {}

  async run(
    input: RunInput,
    observer: RunObserver,
    signal: AbortSignal,
  ): Promise<RunResult> {
    const messages: ModelMessage[] = [
      ...input.history.flatMap((entry) =>
        entry.type === "message"
          ? [{ role: entry.role, content: entry.text } satisfies ModelMessage]
          : [],
      ),
      { role: "user", content: input.text },
    ];

    for (let round = 0; round < MAX_MODEL_ROUNDS; round += 1) {
      let content = "";
      let thinking = "";
      let reason: RunResult["reason"] = "stop";
      const calls = new Map<string, ModelToolCall>();

      try {
        for await (const event of this.model.stream(
          { messages, tools: this.tools.definitions },
          signal,
        )) {
          if (event.type === "text_delta") {
            content += event.text;
            await observer.text(round, event.text);
          } else if (event.type === "thinking_delta") {
            thinking += event.text;
            await observer.thought(round, event.text);
          } else if (event.type === "tool_calls") {
            for (const call of event.calls) {
              calls.set(toolCallKey(call), call);
            }
          } else if (event.type === "finish") {
            reason = event.reason;
          }
        }
      } catch (error) {
        if (isAbort(error) || signal.aborted) return { reason: "cancelled" };
        throw error;
      }

      await observer.roundComplete(round);
      const modelCalls = [...calls.values()];
      if (modelCalls.length === 0) return { reason };

      const prepared = modelCalls.map((call, index) =>
        prepareCall(this.tools, call, `${randomUUID()}:${index}`),
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

      for (const item of prepared) await observer.toolStart(item.call);
      const results = await Promise.all(
        prepared.map((item) => this.execute(item.call, observer, signal)),
      );
      for (let index = 0; index < prepared.length; index += 1) {
        const item = prepared[index];
        const result = results[index];
        if (!item || !result) continue;
        messages.push({
          role: "tool",
          toolName: item.call.name,
          content: result.modelContent,
        });
      }
    }

    throw new Error(`Tool Loop 超过 ${MAX_MODEL_ROUNDS} 轮限制`);
  }

  private async execute(
    call: PreparedToolCall,
    observer: RunObserver,
    signal: AbortSignal,
  ): Promise<ToolResult | { modelContent: string; rawOutput: unknown }> {
    try {
      if (call.validationError) throw new Error(call.validationError);
      if (call.permission === "write") {
        const allowed = await observer.requestWritePermission(call);
        if (!allowed) throw new Error("用户拒绝了写入操作");
      }
      const result = await this.tools.execute(call, {
        askUser: (question, toolCallId) => observer.askUser(question, toolCallId),
        signal,
      });
      await observer.toolFinish(call, "completed", result);
      return result;
    } catch (error) {
      if (isAbort(error) || signal.aborted) throw error;
      const message = errorText(error);
      const result = { modelContent: `工具执行失败: ${message}`, rawOutput: { error: message } };
      await observer.toolFinish(call, "failed", result);
      return result;
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
        permission: "none",
        locations: [],
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
