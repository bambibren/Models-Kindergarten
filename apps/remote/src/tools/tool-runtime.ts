import type { ToolCallStatus } from "@agentclientprotocol/sdk";
import { withRetry } from "../resilience/retry.js";
import {
  modelEnvelope,
  type PreparedToolCall,
  type ToolErrorCategory,
  type ToolOutcome,
  type ToolRegistryPort,
} from "./tool-registry.js";
import { PermissionGate } from "./permission-gate.js";
import { ToolExecutionError } from "./tool-error.js";

export interface ToolObserver {
  toolStart(call: PreparedToolCall): Promise<void>;
  toolFinish(call: PreparedToolCall, status: ToolCallStatus, result: ToolOutcome): Promise<void>;
  requestPermission(call: PreparedToolCall): Promise<boolean>;
  askUser(question: string, toolCallId: string): Promise<string>;
}

export interface ToolBatchResult {
  outcomes: ToolOutcome[];
}

/**
 * 保留为运行接口的兼容参数。重复错误的累计与止损由
 * RepeatedInvalidToolCallGuard 负责；正确调用不在这里去重或复用结果。
 */
export class ToolCallLedger {
}

/** ToolRuntime 在模型已经提出调用后，统一执行权限、局部重试和 Handler。 */
export class ToolRuntime {
  constructor(
    readonly registry: ToolRegistryPort,
    private readonly permissions = new PermissionGate(),
  ) {}

  async executeBatch(
    calls: PreparedToolCall[],
    observer: ToolObserver,
    _ledger: ToolCallLedger,
    signal: AbortSignal,
  ): Promise<ToolBatchResult> {
    for (const call of calls) await observer.toolStart(call);

    const outcomes = await Promise.all(calls.map(async (call) => {
      const outcome = await this.executeOne(call, observer, signal);
      await observer.toolFinish(call, outcome.status === "success" ? "completed" : "failed", outcome);
      return outcome;
    }));
    return { outcomes };
  }

  private async executeOne(
    call: PreparedToolCall,
    observer: ToolObserver,
    signal: AbortSignal,
  ): Promise<ToolOutcome> {
    try {
      if (call.validationError) {
        const validation = typeof call.validationError === "string"
          ? { message: call.validationError }
          : call.validationError;
        return errorOutcome(
          call,
          "invalid_arguments",
          "validation",
          validation.message,
          false,
          undefined,
          {
            ...(validation.validationErrors ? { validation_errors: validation.validationErrors } : {}),
            ...(validation.argumentCorrection ? {
              argument_correction: {
                message: validation.argumentCorrection.message,
                exact_retry_arguments: validation.argumentCorrection.exactRetryArguments,
              },
            } : {}),
            ...(validation.schemaCorrection ? {
              schema_correction: {
                message: validation.schemaCorrection.message,
                expected_schema: validation.schemaCorrection.expectedSchema,
              },
            } : {}),
          },
          validation.instruction,
        );
      }
      const allowed = await this.permissions.authorize(call, observer);
      if (!allowed) {
        return deniedOutcome(
          call,
          call.permission === "deny" ? "策略禁止执行此工具" : "用户拒绝了工具调用",
        );
      }

      const execute = () => this.registry.execute(call, {
        askUser: (question, toolCallId) => observer.askUser(question, toolCallId),
        signal,
      });
      const result = call.retry === "transient"
        ? await withRetry(execute, {
            maxAttempts: 3,
            initialDelayMs: 250,
            maxDelayMs: 2_000,
            jitter: true,
            shouldRetry: isTransientToolError,
          }, signal)
        : await execute();
      return { ...result, status: "success", retryable: false };
    } catch (error) {
      if (isAbort(error) || signal.aborted) throw error;
      const detected = error instanceof ToolExecutionError ? error : undefined;
      return errorOutcome(
        call,
        detected?.code ?? "tool_execution_failed",
        detected?.category ?? "execution",
        errorText(error),
        detected?.retryable ?? false,
        detected?.rawOutput,
        undefined,
        undefined,
        detected?.effects,
      );
    }
  }
}

function deniedOutcome(call: PreparedToolCall, message: string): ToolOutcome {
  return {
    status: "denied",
    retryable: false,
    error: { code: "permission_denied", category: "permission", message },
    modelContent: modelEnvelope(call, false, { code: "permission_denied", message }),
    rawOutput: { error: { code: "permission_denied", message } },
    content: [{ type: "content", content: { type: "text", text: message } }],
    locations: call.locations,
  };
}

function errorOutcome(
  call: PreparedToolCall,
  code: string,
  category: ToolErrorCategory,
  message: string,
  retryable: boolean,
  rawOutput?: unknown,
  details?: Record<string, unknown>,
  instruction?: string,
  effects?: ToolOutcome["effects"],
): ToolOutcome {
  const error = { code, category, message };
  const publicOutput = { error, ...details };
  return {
    status: "error",
    retryable,
    error,
    modelContent: JSON.stringify({
      ok: false,
      tool: call.name,
      toolCallId: call.id,
      ...publicOutput,
      instruction: instruction ?? "The tool operation did not complete. Do not repeat identical arguments.",
    }),
    rawOutput: rawOutput ?? publicOutput,
    content: [{ type: "content", content: { type: "text", text: message } }],
    locations: call.locations,
    ...(effects ? { effects } : {}),
  };
}

function isTransientToolError(error: unknown): boolean {
  return error instanceof ToolExecutionError && error.retryable;
}

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
