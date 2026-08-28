import { canonicalJson, type PreparedToolCall, type ToolOutcome } from "../tools/tool-registry.js";
import type { ModelStudent } from "../model/model-provider.js";

/** 描述「RepeatedInvalidToolCallLimit」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface RepeatedInvalidToolCallLimit {
  toolName: string;
  arguments: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

/** 描述「RepeatedInvalidToolCallGuardFactory」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type RepeatedInvalidToolCallGuardFactory = (
  student: ModelStudent,
) => RepeatedInvalidToolCallGuard | undefined;

/** 产品装配节点：大模型不创建 Guard，因此不会累计或终止。 */
export function createSmallModelRepeatedInvalidToolCallGuard(
  student: ModelStudent,
): RepeatedInvalidToolCallGuard | undefined {
  return student.sizeClass === "small" ? new RepeatedInvalidToolCallGuard(3) : undefined;
}

interface AttemptRecord {
  attempts: number;
  lastRound: number;
}

/**
 * 小模型专用的无效 Tool Call 止损节点。
 * 它只观察 Schema 参数错误；通用错误内容仍由 ToolRuntime 生成。
 */
export class RepeatedInvalidToolCallGuard {
  private readonly attempts = new Map<string, AttemptRecord>();

  /** 初始化「RepeatedInvalidToolCallGuard」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(private readonly maxAttempts = 3) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error("maxAttempts 必须是正整数");
    }
  }

  /** 执行「inspect」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
inspect(
    round: number,
    calls: PreparedToolCall[],
    outcomes: ToolOutcome[],
  ): RepeatedInvalidToolCallLimit | undefined {
    const observedThisRound = new Set<string>();
    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index];
      const outcome = outcomes[index];
      if (!call || !outcome) continue;
      const signature = callSignature(call);
      if (outcome.status === "success") {
        this.attempts.delete(signature);
        continue;
      }
      if (outcome.error?.code !== "invalid_arguments" || observedThisRound.has(signature)) continue;
      observedThisRound.add(signature);

      const previous = this.attempts.get(signature);
      if (previous?.lastRound === round) continue;
      const attempts = (previous?.attempts ?? 0) + 1;
      this.attempts.set(signature, { attempts, lastRound: round });
      if (attempts >= this.maxAttempts) {
        return {
          toolName: call.name,
          arguments: structuredClone(call.arguments),
          attempts,
          maxAttempts: this.maxAttempts,
        };
      }
    }
    return undefined;
  }
}

/** 执行「callSignature」主流程，传播取消与失败并在结束时清理临时资源。 */
function callSignature(call: PreparedToolCall): string {
  return `${call.name}:${canonicalJson(call.arguments)}`;
}
