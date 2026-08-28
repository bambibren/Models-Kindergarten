/** 描述「CircuitStatus」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type CircuitStatus = "closed" | "open" | "half_open";

/** 描述「CircuitOptions」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface CircuitOptions {
  failureThreshold: number;
  cooldownMs: number;
}

/** 描述「CircuitOpenError」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export class CircuitOpenError extends Error {
  /** 初始化「CircuitOpenError」所需依赖，不在构造阶段启动不可回收的后台任务。 */
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

  /** 初始化「CircuitBreaker」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(
    readonly dependency: string,
    private readonly options: CircuitOptions = {
      failureThreshold: 3,
      cooldownMs: 30_000,
    },
  ) {}

  /** 执行「execute」主流程，传播取消与失败并在结束时清理临时资源。 */
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

  /** 执行「snapshot」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
snapshot(): { status: CircuitStatus; failures: number } {
    return { status: this.status, failures: this.failures };
  }

  /** 执行「beforeCall」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
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

  /** 执行「success」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
private success(): void {
    this.status = "closed";
    this.failures = 0;
    this.probing = false;
  }

  /** 执行「failure」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
private failure(): void {
    this.probing = false;
    this.failures += 1;
    if (this.status === "half_open" || this.failures >= this.options.failureThreshold) {
      this.status = "open";
      this.openedAt = Date.now();
    }
  }
}

/** 描述「DependencyCircuits」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export class DependencyCircuits {
  private readonly values = new Map<string, CircuitBreaker>();

  /** 初始化「DependencyCircuits」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(private readonly maxEntries = 128) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error("熔断器注册表容量必须为正整数");
    }
  }

  /** 读取「get」所需数据，并遵守作用域、分页与容量边界。 */
get(key: string): CircuitBreaker {
    const current = this.values.get(key);
    if (current) {
      // Map 的插入次序承担最小 LRU；命中后移到末尾表示最近使用。
      this.values.delete(key);
      this.values.set(key, current);
      return current;
    }
    const created = new CircuitBreaker(key);
    this.values.set(key, created);
    if (this.values.size > this.maxEntries) {
      const oldest = this.values.keys().next().value as string | undefined;
      if (oldest !== undefined) this.values.delete(oldest);
    }
    return created;
  }
}
