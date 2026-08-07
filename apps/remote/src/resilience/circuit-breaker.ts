export type CircuitStatus = "closed" | "open" | "half_open";

export interface CircuitOptions {
  failureThreshold: number;
  cooldownMs: number;
}

export class CircuitOpenError extends Error {
  constructor(readonly dependency: string) {
    super(`外部依赖 ${dependency} 暂时熔断`);
  }
}

/** 单进程单用户版本的依赖熔断器；业务错误不能进入这里。 */
export class CircuitBreaker {
  private status: CircuitStatus = "closed";
  private failures = 0;
  private openedAt = 0;
  private probing = false;

  constructor(
    readonly dependency: string,
    private readonly options: CircuitOptions = {
      failureThreshold: 3,
      cooldownMs: 30_000,
    },
  ) {}

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    this.beforeCall();
    try {
      const value = await operation();
      this.success();
      return value;
    } catch (error) {
      this.failure();
      throw error;
    }
  }

  snapshot(): { status: CircuitStatus; failures: number } {
    return { status: this.status, failures: this.failures };
  }

  private beforeCall(): void {
    if (this.status !== "open") {
      if (this.status === "half_open" && this.probing) throw new CircuitOpenError(this.dependency);
      if (this.status === "half_open") this.probing = true;
      return;
    }
    if (Date.now() - this.openedAt < this.options.cooldownMs) {
      throw new CircuitOpenError(this.dependency);
    }
    this.status = "half_open";
    this.probing = true;
  }

  private success(): void {
    this.status = "closed";
    this.failures = 0;
    this.probing = false;
  }

  private failure(): void {
    this.probing = false;
    this.failures += 1;
    if (this.status === "half_open" || this.failures >= this.options.failureThreshold) {
      this.status = "open";
      this.openedAt = Date.now();
    }
  }
}

export class DependencyCircuits {
  private readonly values = new Map<string, CircuitBreaker>();

  get(key: string): CircuitBreaker {
    const current = this.values.get(key);
    if (current) return current;
    const created = new CircuitBreaker(key);
    this.values.set(key, created);
    return created;
  }
}
