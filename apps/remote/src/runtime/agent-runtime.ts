import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import type { ToolCallStatus } from "@agentclientprotocol/sdk";
import {
  ContextAssembler,
  observeMessage,
} from "../conversation/context-assembler.js";
import type { ModelProvider, ModelToolCall } from "../model/model-provider.js";
import type { SessionEntry } from "../repository/session-types.js";
import {
  noopRuntimeObservationSink,
  type RuntimeObservationSink,
} from "@kindergarten/runtime-observation";
import { toRunFailure } from "./run-failure.js";
import {
  ToolCallLedger,
  ToolRuntime,
} from "../tools/tool-runtime.js";
import type {
  PreparedToolCall,
  ToolOutcome,
  ToolRegistryPort,
} from "../tools/tool-registry.js";

export interface RunInput {
  text: string;
  sessionEntries: SessionEntry[];
  sessionId?: string;
  turnId?: string;
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
    context = new ContextAssembler(),
    observations: RuntimeObservationSink = noopRuntimeObservationSink,
  ) {
    this.runner = new AgentRunner(model, tools, context, observations);
  }

  static fromRegistry(
    model: ModelProvider,
    registry: ToolRegistryPort,
    observations: RuntimeObservationSink = noopRuntimeObservationSink,
  ): AgentRuntime {
    return new AgentRuntime(model, new ToolRuntime(registry), new ContextAssembler(), observations);
  }

  run(input: RunInput, observer: RunObserver, signal: AbortSignal): Promise<RunResult> {
    return this.runner.run(input, observer, signal);
  }
}

export class AgentRunner {
  constructor(
    private readonly model: ModelProvider,
    private readonly tools: ToolRuntime,
    private readonly context: ContextAssembler,
    private readonly observations: RuntimeObservationSink,
  ) {}

  async run(input: RunInput, observer: RunObserver, signal: AbortSignal): Promise<RunResult> {
    const runId = randomUUID();
    const startedAt = Date.now();
    const built = await this.context.buildObserved(input.sessionEntries, input.text, signal);
    const messages = built.messages;
    const contextObservations = built.observations;
    const toolDefinitions = structuredClone(this.tools.registry.definitions);
    const capabilitySnapshot = structuredClone(this.tools.registry.capabilitySnapshot());
    const ledger = new ToolCallLedger();
    const observed = new ObservedRunObserver(observer, this.observations, runId);
    this.observations.emit({
      type: "turn_started",
      runId,
      sessionId: input.sessionId ?? `runtime:${runId}`,
      turnId: input.turnId ?? runId,
      startedAt,
      variant: variantSnapshot(
        this.model,
        toolDefinitions.map((tool) => tool.function.name),
        capabilitySnapshot,
      ),
    });

    for (let round = 0; ; round += 1) {
      const roundId = `${runId}:round:${round}`;
      observed.enterRound(roundId);
      this.observations.emit({
        type: "model_round_started",
        runId,
        roundId,
        index: round,
        startedAt: Date.now(),
        context: {
          messages: [
            observeMessage(
              { role: "system", content: this.model.student.agentConfig.systemPrompt },
              "system",
              "system-prompt",
            ),
            ...structuredClone(contextObservations),
          ],
          truncatedSourceIds: [...built.truncatedSourceIds],
        },
      });
      let content = "";
      let thinking = "";
      let reason: "stop" | "length" | "cancelled" = "stop";
      const calls = new Map<string, ModelToolCall>();
      let firstTokenSeen = false;

      try {
        for await (const event of this.model.stream(
          { messages, tools: toolDefinitions },
          signal,
        )) {
          if (
            !firstTokenSeen &&
            (event.type === "text_delta" ||
              event.type === "thinking_delta" ||
              (event.type === "tool_calls" && event.calls.length > 0))
          ) {
            firstTokenSeen = true;
            this.observations.emit({
              type: "model_round_first_token",
              runId,
              roundId,
              at: Date.now(),
            });
          }
          if (event.type === "text_delta") {
            content += event.text;
            await observed.text(round, event.text);
          } else if (event.type === "thinking_delta") {
            thinking += event.text;
            await observed.thought(round, event.text);
          } else if (event.type === "tool_calls") {
            for (const call of event.calls) calls.set(toolCallKey(call), call);
          } else if (event.type === "usage") {
            this.observations.emit({
              type: "model_round_usage",
              runId,
              roundId,
              ...(event.inputTokens !== undefined ? { inputTokens: event.inputTokens } : {}),
              ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}),
            });
          } else if (event.type === "finish") {
            reason = event.reason;
          }
        }
      } catch (error) {
        if (isAbort(error) || signal.aborted) {
          this.completeTurn(runId, "cancelled", "cancelled");
          return { runId, reason: "cancelled" };
        }
        this.runtimeError(runId, "model", error);
        this.completeTurn(runId, "failed");
        // 模型流无法继续时才提升为 Turn 级失败；具体错误文本保持不变。
        throw toRunFailure(error);
      }

      this.observations.emit({
        type: "model_round_completed",
        runId,
        roundId,
        completedAt: Date.now(),
        stopReason: reason,
        output: {
          text: content,
          ...(thinking ? { thinking } : {}),
        },
      });
      await observed.roundComplete(round);
      const modelCalls = [...calls.values()];
      if (modelCalls.length === 0) {
        this.completeTurn(runId, reason === "cancelled" ? "cancelled" : "completed", reason);
        return { runId, reason };
      }

      const prepared = modelCalls.map((call, index) =>
        prepareCall(this.tools.registry, call, `${randomUUID()}:${index}`),
      );
      const assistantMessage = {
        role: "assistant",
        content,
        ...(thinking ? { thinking } : {}),
        toolCalls: prepared.map(({ modelCall, call }) => ({
          id: call.id,
          name: modelCall.name,
          arguments: modelCall.arguments,
        })),
      } satisfies import("../model/model-provider.js").ModelMessage;
      messages.push(assistantMessage);
      contextObservations.push(observeMessage(
        assistantMessage,
        "current_turn",
        `round:${round}:assistant`,
      ));

      let batch;
      try {
        batch = await this.tools.executeBatch(
          prepared.map((item) => item.call),
          observed,
          ledger,
          signal,
        );
      } catch (error) {
        if (isAbort(error) || signal.aborted) {
          this.completeTurn(runId, "cancelled", "cancelled");
          return { runId, reason: "cancelled" };
        }
        this.runtimeError(runId, "tool_runtime", error);
        this.completeTurn(runId, "failed");
        // ToolRuntime 正常会把工具失败收敛为 ToolOutcome；到达这里说明执行链本身已中断。
        throw toRunFailure(error);
      }
      for (let index = 0; index < prepared.length; index += 1) {
        const item = prepared[index];
        const outcome = batch.outcomes[index];
        if (!item || !outcome) continue;
        const toolMessage = {
          role: "tool",
          toolName: item.call.name,
          toolCallId: item.call.id,
          content: outcome.modelContent,
        } satisfies import("../model/model-provider.js").ModelMessage;
        messages.push(toolMessage);
        contextObservations.push(observeMessage(toolMessage, "tool_result", item.call.id));
      }
    }
  }

  private runtimeError(
    runId: string,
    scope: "model" | "tool_runtime" | "turn",
    error: unknown,
  ): void {
    this.observations.emit({
      type: "runtime_error",
      runId,
      scope,
      message: errorText(error),
      at: Date.now(),
    });
  }

  private completeTurn(
    runId: string,
    status: "completed" | "failed" | "cancelled",
    stopReason?: string,
  ): void {
    this.observations.emit({
      type: "turn_completed",
      runId,
      status,
      completedAt: Date.now(),
      ...(stopReason ? { stopReason } : {}),
    });
  }
}

class ObservedRunObserver implements RunObserver {
  private roundId = "";

  constructor(
    private readonly delegate: RunObserver,
    private readonly observations: RuntimeObservationSink,
    private readonly runId: string,
  ) {}

  enterRound(roundId: string): void { this.roundId = roundId; }
  text(round: number, value: string): Promise<void> { return this.delegate.text(round, value); }
  thought(round: number, value: string): Promise<void> { return this.delegate.thought(round, value); }
  roundComplete(round: number): Promise<void> { return this.delegate.roundComplete(round); }

  async toolStart(call: PreparedToolCall): Promise<void> {
    this.observations.emit({
      type: "tool_call_started",
      runId: this.runId,
      roundId: this.roundId,
      toolCallId: call.id,
      name: call.name,
      arguments: structuredClone(call.arguments),
      signature: call.dedupeKey,
      permission: call.permission,
      startedAt: Date.now(),
    });
    await this.delegate.toolStart(call);
  }

  async toolFinish(
    call: PreparedToolCall,
    status: ToolCallStatus,
    result: ToolOutcome,
  ): Promise<void> {
    this.observations.emit({
      type: "tool_call_completed",
      runId: this.runId,
      toolCallId: call.id,
      status: result.status,
      completedAt: Date.now(),
      ...(result.error
        ? { error: { category: result.error.category, message: result.error.message } }
        : {}),
      output: structuredClone(result.rawOutput),
    });
    await this.delegate.toolFinish(call, status, result);
  }

  async requestPermission(call: PreparedToolCall): Promise<boolean> {
    const allowed = await this.delegate.requestPermission(call);
    this.observations.emit({
      type: "permission_decided",
      runId: this.runId,
      toolCallId: call.id,
      required: true,
      decision: allowed ? "allowed" : "denied",
      decidedAt: Date.now(),
    });
    return allowed;
  }

  askUser(question: string, toolCallId: string): Promise<string> {
    return this.delegate.askUser(question, toolCallId);
  }
}

function variantSnapshot(
  model: ModelProvider,
  toolNames: string[],
  capabilities: ReturnType<ToolRegistryPort["capabilitySnapshot"]>,
) {
  return {
    studentId: model.student.id,
    studentName: model.student.name,
    provider: model.student.provider.kind,
    model: model.student.provider.model,
    ...(model.student.agentConfig.temperature !== undefined
      ? { temperature: model.student.agentConfig.temperature }
      : {}),
    systemPromptHash: createHash("sha256")
      .update(model.student.agentConfig.systemPrompt)
      .digest("hex"),
    runtimeVersion: "1.6",
    toolNames,
    capabilities,
  };
}

function prepareCall(
  registry: ToolRegistryPort,
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
