import type {
  ModelReasoningCapability,
  ModelStudentSummary,
} from "@kindergarten/contracts";
import type { ModelProvider } from "./model-provider.js";

interface CatalogCapabilities {
  streaming: boolean;
  toolCalls: boolean;
  thought: boolean;
  usage: boolean;
  reasoning: ModelReasoningCapability;
}

export interface ModelStudentRegistration {
  initialStatus?: ModelStudentSummary["status"];
  statusMessage?: string;
  lastCheckedAt?: string;
  deletable?: boolean;
  supports?: Partial<Omit<CatalogCapabilities, "reasoning">> & { reasoning?: ModelReasoningCapability };
}

interface CatalogItem {
  provider: ModelProvider;
  status: ModelStudentSummary["status"];
  statusMessage?: string;
  lastCheckedAt?: string;
  deletable: boolean;
  supports: CatalogCapabilities;
}

/** 当前进程所有可选择模型的运行目录；内置与用户入园模型走同一解析路径。 */
export class ModelStudentCatalog {
  private readonly items = new Map<string, CatalogItem>();
  private readonly defaultId: string;

  constructor(
    provider: ModelProvider,
    initialStatus: ModelStudentSummary["status"] = "unknown",
  ) {
    this.defaultId = provider.student.id;
    this.register(provider, { initialStatus, deletable: false });
  }

  register(provider: ModelProvider, options: ModelStudentRegistration = {}): ModelStudentSummary {
    if (this.items.has(provider.student.id)) throw new Error(`ModelStudent 已注册: ${provider.student.id}`);
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

  async verify(id = this.defaultId): Promise<ModelStudentSummary> {
    const item = this.requireItem(id);
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

  async verifyAll(): Promise<ModelStudentSummary[]> {
    return Promise.all([...this.items.keys()].map((id) => this.verify(id)));
  }

  all(): ModelStudentSummary[] {
    return [...this.items.values()].map((item) => this.summary(item));
  }

  get(id: string): ModelStudentSummary | undefined {
    const item = this.items.get(id);
    return item ? this.summary(item) : undefined;
  }

  provider(id: string, requireReady = true): ModelProvider | undefined {
    const item = this.items.get(id);
    if (!item || requireReady && item.status !== "ready") return undefined;
    return item.provider;
  }

  requireProvider(id: string): ModelProvider {
    const item = this.items.get(id);
    if (!item) throw new Error(`ModelStudent 不存在: ${id}`);
    if (item.status !== "ready") throw new Error(`ModelStudent 不可用: ${id}`);
    return item.provider;
  }

  defaultProvider(): ModelProvider {
    return this.requireItem(this.defaultId).provider;
  }

  isReady(id: string): boolean {
    return this.items.get(id)?.status === "ready";
  }

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

  unregister(id: string): ModelProvider {
    const item = this.requireItem(id);
    if (!item.deletable) throw new Error("系统内置 ModelStudent 不可删除");
    this.items.delete(id);
    return item.provider;
  }

  private requireItem(id: string): CatalogItem {
    const item = this.items.get(id);
    if (!item) throw new Error(`ModelStudent 不存在: ${id}`);
    return item;
  }

  private summary(item: CatalogItem): ModelStudentSummary {
    const supports = structuredClone(item.supports);
    const contextWindowTokens = item.provider.student.contextWindowTokens;
    const configuredDefault = item.provider.student.generationDefaults.reasoningProfile;
    if (configuredDefault) supports.reasoning.defaultProfile = configuredDefault;
    return {
      schemaVersion: 1,
      modelStudentId: item.provider.student.id,
      displayName: item.provider.student.name,
      sizeClass: item.provider.student.sizeClass,
      providerKind: item.provider.student.provider.kind,
      model: item.provider.student.provider.model,
      status: item.status,
      supports,
      ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
      deletable: item.deletable,
      ...(item.lastCheckedAt ? { lastCheckedAt: item.lastCheckedAt } : {}),
      ...(item.statusMessage ? { statusMessage: item.statusMessage } : {}),
    };
  }
}
