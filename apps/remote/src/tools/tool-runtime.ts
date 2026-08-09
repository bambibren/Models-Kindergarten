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

interface LedgerRecord {
  callId: string;
  status?: ToolOutcome["status"];
  outcome?: ToolOutcome;
  duplicateCount: number;
}

export class ToolCallLedger {
  private readonly byKey = new Map<string, LedgerRecord>();

  register(call: PreparedToolCall): { duplicate?: LedgerRecord } {
    const existing = this.byKey.get(call.dedupeKey);
    if (!existing) {
      this.byKey.set(call.dedupeKey, { callId: call.id, duplicateCount: 0 });
      return {};
    }
    existing.duplicateCount += 1;
    return { duplicate: existing };
  }

  complete(call: PreparedToolCall, outcome: ToolOutcome): void {
    const record = this.byKey.get(call.dedupeKey);
    if (record && record.callId === call.id) {
      record.status = outcome.status;
      record.outcome = outcome;
    }
  }
}

/** ToolRuntime 在模型已经提出调用后，统一执行去重、权限、局部重试和 Handler。 */
export class ToolRuntime {
  constructor(
    readonly registry: ToolRegistryPort,
    private readonly permissions = new PermissionGate(),
  ) {}

  async executeBatch(
    calls: PreparedToolCall[],
    observer: ToolObserver,
    ledger: ToolCallLedger,
    signal: AbortSignal,
  ): Promise<ToolBatchResult> {
    for (const call of calls) await observer.toolStart(call);

    const decisions = calls.map((call) => ledger.register(call));
    const outcomes = await Promise.all(calls.map(async (call, index) => {
      const decision = decisions[index];
      if (decision?.duplicate) {
        const outcome = duplicateOutcome(call, decision.duplicate);
        await observer.toolFinish(
          call,
          decision.duplicate.status === "success" ? "completed" : "failed",
          outcome,
        );
        return outcome;
      }

      const outcome = await this.executeOne(call, observer, signal);
      ledger.complete(call, outcome);
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
        return errorOutcome(call, "invalid_arguments", "validation", call.validationError, false);
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
      );
    }
  }
}

function duplicateOutcome(call: PreparedToolCall, previous: LedgerRecord): ToolOutcome {
  const completed = previous.outcome?.status === "success";
  const rawOutput = {
    previousCallId: previous.callId,
    previousStatus: previous.status ?? "running",
    previousOutput: previous.outcome?.rawOutput,
  };
  return {
    status: "duplicate_blocked",
    retryable: false,
    modelContent: JSON.stringify({
      ok: completed,
      cached: true,
      tool: call.name,
      toolCallId: call.id,
      code: "duplicate_tool_call",
      ...rawOutput,
      instruction: "相同工具和参数已经处理；直接使用 previousOutput，不要再次调用。",
    }),
    rawOutput,
    content: [{ type: "content", content: { type: "text", text: "已阻止重复工具调用" } }],
    locations: call.locations,
  };
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
): ToolOutcome {
  const error = { code, category, message };
  return {
    status: "error",
    retryable,
    error,
    modelContent: modelEnvelope(call, false, error),
    rawOutput: rawOutput ?? { error },
    content: [{ type: "content", content: { type: "text", text: message } }],
    locations: call.locations,
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
