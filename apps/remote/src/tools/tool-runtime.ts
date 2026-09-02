import type { ToolCallStatus } from "@agentclientprotocol/sdk";
import {
  modelEnvelope,
  type PreparedToolCall,
  type ToolErrorCategory,
  type ToolOutcome,
  type ToolRegistryPort,
} from "./tool-registry.js";
import { PermissionGate } from "./permission-gate.js";
import { ToolExecutionError } from "./tool-error.js";
import { PRODUCT_CONFIG } from "@kindergarten/contracts";

/** 描述「ToolObserver」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ToolObserver {
  toolExecutionStarted?(call: PreparedToolCall): Promise<void>;
  toolFinish(call: PreparedToolCall, status: ToolCallStatus, result: ToolOutcome): Promise<void>;
  requestPermission(call: PreparedToolCall): Promise<boolean>;
  askUser(question: string, toolCallId: string): Promise<string>;
}

/** 描述「ToolBatchResult」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ToolBatchResult {
  outcomes: ToolOutcome[];
}

/** 保留为运行接口的兼容参数；正确调用不在这里去重或复用结果。 */
export class ToolCallLedger {
}

/** ToolRuntime 在模型已经提出调用后，统一执行权限与 Handler；产品层不做隐式自动重试。 */
export class ToolRuntime {
  private readonly heavyExecution = new AsyncSemaphore(PRODUCT_CONFIG.tools.maxHeavyConcurrency);

  /** 初始化「ToolRuntime」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(
    readonly registry: ToolRegistryPort,
    private readonly permissions = new PermissionGate(),
  ) {}

  /** 执行「executeBatch」主流程，传播取消与失败并在结束时清理临时资源。 */
async executeBatch(
    calls: PreparedToolCall[],
    observer: ToolObserver,
    _ledger: ToolCallLedger,
    signal: AbortSignal,
  ): Promise<ToolBatchResult> {
    const outcomes = await mapWithConcurrency(
      calls,
      PRODUCT_CONFIG.tools.maxBatchConcurrency,
      /** 每个 worker 完成权限、执行和终态投影；外层按原下标收集，不能按完成先后重排。 */
async (call) => {
      const outcome = await this.executeWithResourceClass(call, observer, signal);
      await observer.toolFinish(call, outcome.status === "success" ? "completed" : "failed", outcome);
      return outcome;
      },
    );
    return { outcomes };
  }

  /** 高内存构建使用独立信号量；普通工具仍受批次的四路并发上限约束。 */
  private executeWithResourceClass(
    call: PreparedToolCall,
    observer: ToolObserver,
    signal: AbortSignal,
  ): Promise<ToolOutcome> {
    return call.name === "build_pptx"
      ? this.heavyExecution.run(/** 只有高内存 PPTX 构建占用独立重型名额，普通工具不被该队列阻塞。 */
() => this.executeOne(call, observer, signal), signal)
      : this.executeOne(call, observer, signal);
  }

  /** 执行「executeOne」主流程，传播取消与失败并在结束时清理临时资源。 */
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

      await observer.toolExecutionStarted?.(call);
      const execute = /** 执行「execute」主流程，传播取消与失败并在结束时清理临时资源。 */
() => this.registry.execute(call, {
        askUser: /** 执行「askUser」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(question, toolCallId) => observer.askUser(question, toolCallId),
        signal,
      });
      // 产品层不做隐式自动重试；可重试错误由 UI 暴露给用户手动发起，避免重复副作用和付费调用。
      const result = await execute();
      return enforceResultViewLimit(call, { ...result, status: "success", retryable: false });
    } catch (error) {
      if (isAbort(error) || signal.aborted) throw error;
      const detected = error instanceof ToolExecutionError ? error : undefined;
      return enforceResultViewLimit(call, errorOutcome(
        call,
        detected?.code ?? "tool_execution_failed",
        detected?.category ?? "execution",
        errorText(error),
        detected?.retryable ?? false,
        detected?.rawOutput,
        undefined,
        undefined,
        detected?.effects,
      ));
    }
  }
}

/**
 * 并发映射器只保留固定数量的在途 Promise，并按输入下标写回结果。
 * 任一任务失败时停止领取新任务，但已开始的任务仍由自身 AbortSignal 收敛。
 */
async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    /** 执行「workers」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        const value = values[index];
        if (value === undefined) continue;
        results[index] = await operation(value, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/** 只为重型 Tool 排队；取消的等待者不会在取得名额后继续执行。 */
class AsyncSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  /** 初始化「AsyncSemaphore」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(private readonly limit: number) {}

  /** 执行「run」主流程，传播取消与失败并在结束时清理临时资源。 */
async run<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      if (signal.aborted) throw new DOMException("已取消", "AbortError");
      return await operation();
    } finally {
      this.release();
    }
  }

  /** 立即取得名额或登记可取消等待者；等待数组上界来自 Turn 与 Tool Call 硬预算。 */
private async acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new DOMException("已取消", "AbortError");
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>(/** 完成当前异步桥接，并保证每条分支只结算一次。 */
(resolve, reject) => {
      const grant = /** 取得名额前解除 abort 监听，防止已执行任务再次触发取消回调。 */
() => {
        signal.removeEventListener("abort", cancel);
        this.active += 1;
        resolve();
      };
      const cancel = /** 从等待队列移除本任务再拒绝 Promise，避免取消项日后被误授予名额。 */
() => {
        const index = this.waiters.indexOf(grant);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new DOMException("已取消", "AbortError"));
      };
      this.waiters.push(grant);
      signal.addEventListener("abort", cancel, { once: true });
    });
  }

  /** 释放当前名额并只唤醒队首等待者，使 active 在 grant 时恢复而不超限。 */
private release(): void {
    this.active -= 1;
    this.waiters.shift()?.();
  }
}

/**
 * 工具成功与失败都必须在写入 Session、ACP 或模型上下文前完成统一大小检查。
 * 超限时丢弃整个原结果并返回一个小型结构化错误，绝不保存截断后的“半份成功”。
 */
function enforceResultViewLimit(call: PreparedToolCall, outcome: ToolOutcome): ToolOutcome {
  try {
    const bytes = Buffer.byteLength(JSON.stringify({
      modelContent: outcome.modelContent,
      rawOutput: outcome.rawOutput,
      content: outcome.content,
      locations: outcome.locations,
      effects: outcome.effects,
    }));
    if (bytes <= PRODUCT_CONFIG.tools.maxResultViewBytes) return outcome;
  } catch {
    // 循环引用、BigInt 等不可序列化结果与超限结果使用同一个明确失败边界。
  }
  return errorOutcome(
    call,
    "tool_result_too_large",
    "resource_limit",
    `工具结果超过 ${PRODUCT_CONFIG.tools.maxResultViewBytes} 字节，未写入模型上下文或 ACP`,
    false,
  );
}

/** 将策略或用户拒绝转换为模型、ACP 与 Session 共用的有限终态视图。 */
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

/** 构造统一失败 Outcome；`modelContent` 是下一轮唯一进入模型上下文的结果视图。 */
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

/** 把未知异常转换为「errorText」文本，避免错误序列化过程再次抛出。 */
function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/** 判断「isAbort」对应条件，只返回判定结果且不修改输入状态。 */
function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
