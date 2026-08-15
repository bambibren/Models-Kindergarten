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
  private readonly waiters = new Set<{
    resolve: (client: acp.AgentContext) => void;
    reject: (error: Error) => void;
  }>();
  private closed = false;

  constructor(client?: acp.AgentContext) {
    if (client) this.client = client;
  }

  attach(client: acp.AgentContext): void {
    if (this.closed) return;
    this.client = client;
    for (const waiter of this.waiters) waiter.resolve(client);
    this.waiters.clear();
  }

  detach(client: acp.AgentContext): void {
    if (this.client === client) this.client = undefined;
  }

  /** resume 回放时暂存新的实时通知，确保“缺口快照”先于后续增量到达。 */
  beginResume(): void {
    if (this.closed) return;
    this.client = undefined;
    this.buffered = [];
  }

  async finishResume(client: acp.AgentContext): Promise<void> {
    if (this.closed) return;
    const buffered = this.buffered ?? [];
    for (let index = 0; index < buffered.length; index += 1) {
      const item = buffered[index]!;
      try {
        await item.operation(client);
      } catch (error) {
        console.warn(`ACP 实时投影失败: ${item.label}`, error);
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
      console.warn(`ACP 实时投影失败: ${label}`, error);
    }
  }

  async request<T>(
    signal: AbortSignal,
    operation: (client: acp.AgentContext) => Promise<T>,
  ): Promise<T> {
    for (;;) {
      const current = await this.waitForClient(signal);
      try {
        return await operation(current);
      } catch (error) {
        if (signal.aborted) throw abortError();
        if (error instanceof acp.RequestError) throw error;
        this.detach(current);
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.client = undefined;
    this.buffered = undefined;
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
}

function abortError(): DOMException {
  return new DOMException("已取消", "AbortError");
}
