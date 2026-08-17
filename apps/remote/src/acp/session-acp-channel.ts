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

  constructor(client?: acp.AgentContext, private readonly sessionId?: string) {
    if (client) this.client = client;
  }

  attach(client: acp.AgentContext): void {
    if (this.closed) return;
    this.client = client;
    this.markClientChanged();
    console.warn("[acp-channel] client attached", JSON.stringify({ sessionId: this.sessionId, clientVersion: this.clientVersion }));
    for (const waiter of this.waiters) waiter.resolve(client);
    this.waiters.clear();
  }

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
            (value) => ({ kind: "result" as const, value }),
            (error: unknown) => ({ kind: "error" as const, error }),
          ),
          changed.promise.then(() => ({ kind: "changed" as const })),
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

  private waitForClient(signal: AbortSignal): Promise<acp.AgentContext> {
    if (signal.aborted) return Promise.reject(abortError());
    if (this.client) return Promise.resolve(this.client);
    if (this.closed) return Promise.reject(new Error("Session ACP channel 已关闭"));
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (client: acp.AgentContext) => {
          signal.removeEventListener("abort", abort);
          resolve(client);
        },
        reject: (error: Error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      };
      const abort = () => {
        this.waiters.delete(waiter);
        waiter.reject(abortError());
      };
      this.waiters.add(waiter);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  private waitForClientChange(version: number, signal: AbortSignal): {
    promise: Promise<void>;
    cancel: () => void;
  } {
    let waiter: (() => void) | undefined;
    let abort: (() => void) | undefined;
    const cleanup = () => {
      if (waiter) this.changeWaiters.delete(waiter);
      if (abort) signal.removeEventListener("abort", abort);
    };
    const promise = new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      if (version !== this.clientVersion) {
        resolve();
        return;
      }
      waiter = () => {
        cleanup();
        resolve();
      };
      abort = () => {
        cleanup();
        reject(abortError());
      };
      this.changeWaiters.add(waiter);
      signal.addEventListener("abort", abort, { once: true });
    });
    return { promise, cancel: cleanup };
  }

  private markClientChanged(): void {
    this.clientVersion += 1;
    for (const waiter of [...this.changeWaiters]) waiter();
  }
}

function abortError(): DOMException {
  return new DOMException("已取消", "AbortError");
}

function errorFacts(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "UnknownError", message: String(error) };
}
