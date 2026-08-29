import type {
  ModelReasoningCapability,
  ModelStudentSummary,
} from "@kindergarten/contracts";
import type { ModelProvider } from "./model-provider.js";
import type { ModelStudent } from "./model-provider.js";
import { PRODUCT_CONFIG } from "@kindergarten/contracts";

interface CatalogCapabilities {
  streaming: boolean;
  toolCalls: boolean;
  thought: boolean;
  usage: boolean;
  reasoning: ModelReasoningCapability;
}

/** 描述「ModelStudentRegistration」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ModelStudentRegistration {
  initialStatus?: ModelStudentSummary["status"];
  statusMessage?: string;
  lastCheckedAt?: string;
  deletable?: boolean;
  supports?: Partial<Omit<CatalogCapabilities, "reasoning">> & { reasoning?: ModelReasoningCapability };
}

interface CatalogItem {
  student: ModelStudent;
  provider?: ModelProvider;
  status: ModelStudentSummary["status"];
  statusMessage?: string;
  lastCheckedAt?: string;
  deletable: boolean;
  supports: CatalogCapabilities;
}

/** 当前进程所有可选择模型的运行目录；内置与用户入园模型走同一解析路径。 */
export class ModelStudentCatalog {
  private readonly items = new Map<string, CatalogItem>();

  /** 测试可显式传入单个 Provider；生产启动使用空构造，不存在隐式默认模型。 */
constructor(
    provider?: ModelProvider,
    initialStatus: ModelStudentSummary["status"] = "unknown",
  ) {
    if (provider) this.register(provider, { initialStatus, deletable: true });
  }

  /** 执行「register」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
register(provider: ModelProvider, options: ModelStudentRegistration = {}): ModelStudentSummary {
    if (this.items.has(provider.student.id)) throw new Error(`ModelStudent 已注册: ${provider.student.id}`);
    if (this.items.size >= PRODUCT_CONFIG.capacity.maxModelStudents) {
      throw new Error(`ModelStudent 运行目录已达到 ${PRODUCT_CONFIG.capacity.maxModelStudents} 条容量上限`);
    }
    const fixedBalanced: ModelReasoningCapability = {
      schemaVersion: 1,
      control: "fixed",
      adjustable: false,
      supportedProfiles: ["balanced"],
      defaultProfile: "balanced",
    };
    const reasoning = structuredClone(options.supports?.reasoning ?? provider.reasoningCapability ?? fixedBalanced);
    const configuredDefault = provider.student.generationDefaults.reasoningProfile;
    if (configuredDefault && !reasoning.supportedProfiles.includes(configuredDefault)) {
      throw new Error(`ModelStudent ${provider.student.id} 的默认推理档位不在已验证能力中: ${configuredDefault}`);
    }
    const item: CatalogItem = {
      student: structuredClone(provider.student),
      provider,
      status: options.initialStatus ?? "unknown",
      ...(options.statusMessage ? { statusMessage: options.statusMessage } : {}),
      ...(options.lastCheckedAt ? { lastCheckedAt: options.lastCheckedAt } : {}),
      deletable: options.deletable ?? true,
      supports: {
        streaming: options.supports?.streaming ?? true,
        toolCalls: options.supports?.toolCalls ?? true,
        thought: options.supports?.thought ?? true,
        usage: options.supports?.usage ?? true,
        reasoning,
      },
    };
    this.items.set(provider.student.id, item);
    return this.summary(item);
  }

  /** 旧持久化记录超过容量时只登记安全元数据，不创建 Provider 或参与 Runtime。 */
  registerCapacityBlocked(
    student: ModelStudent,
    options: Omit<ModelStudentRegistration, "initialStatus"> = {},
  ): ModelStudentSummary {
    if (this.items.has(student.id)) throw new Error(`ModelStudent 已注册: ${student.id}`);
    const fixedBalanced: ModelReasoningCapability = {
      schemaVersion: 1,
      control: "fixed",
      adjustable: false,
      supportedProfiles: ["balanced"],
      defaultProfile: "balanced",
    };
    const item: CatalogItem = {
      student: structuredClone(student),
      status: "capacity_blocked",
      statusMessage: options.statusMessage ?? `ModelStudent 运行目录已达到 ${PRODUCT_CONFIG.capacity.maxModelStudents} 条容量上限`,
      ...(options.lastCheckedAt ? { lastCheckedAt: options.lastCheckedAt } : {}),
      deletable: options.deletable ?? true,
      supports: {
        streaming: options.supports?.streaming ?? true,
        toolCalls: options.supports?.toolCalls ?? true,
        thought: options.supports?.thought ?? true,
        usage: options.supports?.usage ?? true,
        reasoning: structuredClone(options.supports?.reasoning ?? fixedBalanced),
      },
    };
    this.items.set(student.id, item);
    return this.summary(item);
  }

  /** 归档模型只保留安全元数据，不实例化或持有任何 Provider。 */
registerUnavailable(
    student: ModelStudent,
    statusMessage: string,
    options: Omit<ModelStudentRegistration, "initialStatus" | "statusMessage"> = {},
  ): ModelStudentSummary {
    const summary = this.registerCapacityBlocked(student, options);
    const item = this.requireItem(student.id);
    item.status = "unavailable";
    item.statusMessage = statusMessage;
    return { ...summary, status: "unavailable", statusMessage };
  }

  /** 执行「verify」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async verify(id: string): Promise<ModelStudentSummary> {
    const item = this.requireItem(id);
    if (!item.provider) return this.summary(item);
    try {
      await item.provider.verify?.();
      item.status = "ready";
      delete item.statusMessage;
    } catch (error) {
      item.status = "unavailable";
      item.statusMessage = error instanceof Error ? error.message : String(error);
    }
    item.lastCheckedAt = new Date().toISOString();
    return this.summary(item);
  }

  /** 执行「verifyAll」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
async verifyAll(): Promise<ModelStudentSummary[]> {
    return Promise.all([...this.items.keys()].map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(id) => this.verify(id)));
  }

  /** 执行「all」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
all(): ModelStudentSummary[] {
    return [...this.items.values()].map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => this.summary(item));
  }

  /** 返回真正持有 Provider、可占用连接和流资源的目录条目数。 */
  get runtimeProviderCount(): number {
    return [...this.items.values()].filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.provider !== undefined).length;
  }

  /** 读取「get」所需数据，并遵守作用域、分页与容量边界。 */
get(id: string): ModelStudentSummary | undefined {
    const item = this.items.get(id);
    return item ? this.summary(item) : undefined;
  }

  /** 执行「provider」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
provider(id: string, requireReady = true): ModelProvider | undefined {
    const item = this.items.get(id);
    if (!item || requireReady && item.status !== "ready") return undefined;
    return item.provider;
  }

  /** 校验并取得「requireProvider」所需对象；缺失或归属不符时立即抛出明确错误。 */
requireProvider(id: string): ModelProvider {
    const item = this.items.get(id);
    if (!item) throw new Error(`ModelStudent 不存在: ${id}`);
    if (item.status !== "ready" || !item.provider) throw new Error(`ModelStudent 不可用: ${id}`);
    return item.provider;
  }

  /** 判断「isReady」对应条件，只返回判定结果且不修改输入状态。 */
isReady(id: string): boolean {
    return this.items.get(id)?.status === "ready";
  }

  /** 更新「setStatus」对应状态，并保持写入顺序、原子性与容量约束。 */
setStatus(
    id: string,
    status: ModelStudentSummary["status"],
    statusMessage?: string,
  ): ModelStudentSummary {
    const item = this.requireItem(id);
    item.status = status;
    item.lastCheckedAt = new Date().toISOString();
    if (statusMessage) item.statusMessage = statusMessage;
    else delete item.statusMessage;
    return this.summary(item);
  }

  /** 执行「unregister」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
unregister(id: string): ModelProvider | undefined {
    const item = this.requireItem(id);
    if (!item.deletable) throw new Error("系统内置 ModelStudent 不可删除");
    this.items.delete(id);
    return item.provider;
  }

  /** 停用模型时保留可展示元数据，但释放 Provider 并禁止新 Turn 使用。 */
deactivate(id: string, statusMessage: string): ModelProvider | undefined {
    const item = this.requireItem(id);
    const provider = item.provider;
    delete item.provider;
    item.status = "unavailable";
    item.statusMessage = statusMessage;
    item.lastCheckedAt = new Date().toISOString();
    item.deletable = true;
    return provider;
  }

  /** 校验并取得「requireItem」所需对象；缺失或归属不符时立即抛出明确错误。 */
private requireItem(id: string): CatalogItem {
    const item = this.items.get(id);
    if (!item) throw new Error(`ModelStudent 不存在: ${id}`);
    return item;
  }

  /** 汇总「summary」对应指标，保持缺失字段语义且不重复计算同一来源。 */
private summary(item: CatalogItem): ModelStudentSummary {
    const supports = structuredClone(item.supports);
    const contextWindowTokens = item.student.contextWindowTokens;
    const configuredDefault = item.student.generationDefaults.reasoningProfile;
    if (configuredDefault) supports.reasoning.defaultProfile = configuredDefault;
    return {
      schemaVersion: 1,
      modelStudentId: item.student.id,
      displayName: item.student.name,
      sizeClass: item.student.sizeClass,
      providerKind: item.student.provider.kind,
      model: item.student.provider.model,
      status: item.status,
      supports,
      ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
      deletable: item.deletable,
      ...(item.lastCheckedAt ? { lastCheckedAt: item.lastCheckedAt } : {}),
      ...(item.statusMessage ? { statusMessage: item.statusMessage } : {}),
    };
  }
}
