import * as acp from "@agentclientprotocol/sdk";

type Projection = (client: acp.AgentContext) => Promise<void>;
interface BufferedProjection { operation: Projection; label: string }

/**
 * 活动 Turn 的 ACP 出口。Runtime 生命周期不属于某条 WebSocket；resume 只替换出口。
 * 断线期间普通通知直接跳过，依赖用户回答的反向请求则等待下一条连接。
 */
export class SessionAcpChannel {
  private client: acp.AgentContext | undefined;
  private buffered: BufferedProjection[] | undefined;
  private clientVersion = 0;
  private readonly waiters = new Set<{
    resolve: (client: acp.AgentContext) => void;
    reject: (error: Error) => void;
  }>();
  private readonly changeWaiters = new Set<() => void>();
  private readonly activeRequests = new Set<string>();
  private closed = false;

  /** 初始化「SessionAcpChannel」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(client?: acp.AgentContext, private readonly sessionId?: string) {
    if (client) this.client = client;
  }

  /** 执行「attach」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
attach(client: acp.AgentContext): void {
    if (this.closed) return;
    this.client = client;
    this.markClientChanged();
    console.warn("[acp-channel] client attached", JSON.stringify({ sessionId: this.sessionId, clientVersion: this.clientVersion }));
    for (const waiter of this.waiters) waiter.resolve(client);
    this.waiters.clear();
  }

  /** 执行「detach」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
detach(client: acp.AgentContext): void {
    if (this.client === client) {
      this.client = undefined;
      this.markClientChanged();
      console.warn("[acp-channel] client detached", JSON.stringify({ sessionId: this.sessionId, clientVersion: this.clientVersion }));
    }
  }

  /** resume 回放时暂存新的实时通知，确保“缺口快照”先于后续增量到达。 */
  beginResume(): void {
    if (this.closed) return;
    this.client = undefined;
    this.buffered = [];
    this.markClientChanged();
    console.warn("[acp-channel] resume started", JSON.stringify({ sessionId: this.sessionId, clientVersion: this.clientVersion }));
  }

  /** 先按序发送回放期间缓冲的实时更新，再退出 resume 模式，避免回放与新事件交叉乱序。 */
async finishResume(client: acp.AgentContext): Promise<void> {
    if (this.closed) return;
    const buffered = this.buffered ?? [];
    for (let index = 0; index < buffered.length; index += 1) {
      const item = buffered[index]!;
      try {
        await item.operation(client);
      } catch (error) {
        console.warn(`ACP 实时投影失败: ${item.label}`, errorFacts(error));
        this.buffered = undefined;
        return;
      }
    }
    this.buffered = undefined;
    this.attach(client);
  }

  /** 将一次 Runtime 投影交给当前 Client；resume 期间只缓冲当前有界窗口内的增量。 */
async project(operation: Projection, label: string): Promise<void> {
    if (this.closed) return;
    if (this.buffered) {
      this.buffered.push({ operation, label });
      return;
    }
    const current = this.client;
    if (!current) return;
    try {
      await operation(current);
    } catch (error) {
      this.detach(current);
      console.warn(`ACP 实时投影失败: ${label}`, errorFacts(error));
    }
  }

  /** 执行「request」主流程，传播取消与失败并在结束时清理临时资源。 */
async request<T>(
    interactionId: string,
    signal: AbortSignal,
    operation: (client: acp.AgentContext) => Promise<T>,
  ): Promise<T> {
    if (this.activeRequests.has(interactionId)) {
      throw new Error(`ACP interaction 已在等待: ${interactionId}`);
    }
    this.activeRequests.add(interactionId);
    try {
      return await this.requestUntilResolved(interactionId, signal, operation);
    } finally {
      this.activeRequests.delete(interactionId);
    }
  }

  /** 执行「requestUntilResolved」主流程，传播取消与失败并在结束时清理临时资源。 */
private async requestUntilResolved<T>(
    interactionId: string,
    signal: AbortSignal,
    operation: (client: acp.AgentContext) => Promise<T>,
  ): Promise<T> {
    let attempt = 0;
    for (;;) {
      const current = await this.waitForClient(signal);
      const version = this.clientVersion;
      attempt += 1;
      const changed = this.waitForClientChange(version, signal);
      try {
        const outcome = await Promise.race([
          operation(current).then(
            /** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
(value) => ({ kind: "result" as const, value }),
            /** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
(error: unknown) => ({ kind: "error" as const, error }),
          ),
          changed.promise.then(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => ({ kind: "changed" as const })),
        ]);
        if (outcome.kind === "changed") {
          console.warn("[acp-channel] reverse request reissuing after client change", JSON.stringify({
            sessionId: this.sessionId,
            interactionId,
            attempt,
            previousClientVersion: version,
            clientVersion: this.clientVersion,
          }));
          continue;
        }
        if (outcome.kind === "result") return outcome.value;
        throw outcome.error;
      } catch (error) {
        if (signal.aborted) throw abortError();
        if (error instanceof acp.RequestError) throw error;
        console.warn("[acp-channel] reverse request failed; waiting for resume", {
          sessionId: this.sessionId,
          interactionId,
          attempt,
          error: errorFacts(error),
        });
        this.detach(current);
      } finally {
        changed.cancel();
      }
    }
  }

  /** 释放或删除「close」对应资源，重复调用仍保持安全。 */
close(): void {
    if (this.closed) return;
    this.closed = true;
    this.client = undefined;
    this.buffered = undefined;
    this.markClientChanged();
    console.warn("[acp-channel] closed", JSON.stringify({ sessionId: this.sessionId, clientVersion: this.clientVersion }));
    const error = new Error("Session ACP channel 已关闭");
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters.clear();
  }

  /** 执行「waitForClient」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
private waitForClient(signal: AbortSignal): Promise<acp.AgentContext> {
    if (signal.aborted) return Promise.reject(abortError());
    if (this.client) return Promise.resolve(this.client);
    if (this.closed) return Promise.reject(new Error("Session ACP channel 已关闭"));
    return new Promise(/** 完成当前异步桥接，并保证每条分支只结算一次。 */
(resolve, reject) => {
      const waiter = {
        resolve: /** 执行「resolve」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(client: acp.AgentContext) => {
          signal.removeEventListener("abort", abort);
          resolve(client);
        },
        reject: /** 执行「reject」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(error: Error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      };
      const abort = /** 执行「abort」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
() => {
        this.waiters.delete(waiter);
        waiter.reject(abortError());
      };
      this.waiters.add(waiter);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  /** 执行「waitForClientChange」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
private waitForClientChange(version: number, signal: AbortSignal): {
    promise: Promise<void>;
    cancel: () => void;
  } {
    let waiter: (() => void) | undefined;
    let abort: (() => void) | undefined;
    const cleanup = /** 释放或删除「cleanup」对应资源，重复调用仍保持安全。 */
() => {
      if (waiter) this.changeWaiters.delete(waiter);
      if (abort) signal.removeEventListener("abort", abort);
    };
    const promise = new Promise<void>(/** 完成当前异步桥接，并保证每条分支只结算一次。 */
(resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      if (version !== this.clientVersion) {
        resolve();
        return;
      }
      waiter = /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
() => {
        cleanup();
        resolve();
      };
      abort = /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
() => {
        cleanup();
        reject(abortError());
      };
      this.changeWaiters.add(waiter);
      signal.addEventListener("abort", abort, { once: true });
    });
    return { promise, cancel: cleanup };
  }

  /** 执行「markClientChanged」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
private markClientChanged(): void {
    this.clientVersion += 1;
    for (const waiter of [...this.changeWaiters]) waiter();
  }
}

/** 执行「abortError」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function abortError(): DOMException {
  return new DOMException("已取消", "AbortError");
}

/** 生成「errorFacts」不可变视图，隔离后续状态修改并只暴露该层需要的事实。 */
function errorFacts(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "UnknownError", message: String(error) };
}
