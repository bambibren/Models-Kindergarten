import { createHash } from "node:crypto";
import type { ModelToolCall, ModelToolDefinition } from "../model/model-provider.js";
import type {
  PreparedToolCall,
  ToolExecutionContext,
  ToolRegistryPort,
  ToolResult,
} from "../tools/tool-registry.js";
import type { RuntimeCapabilitySnapshot } from "./capability-types.js";
import { PRODUCT_CONFIG } from "@kindergarten/contracts";

/** 描述「RuntimeToolProvider」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface RuntimeToolProvider extends ToolRegistryPort {
  readonly providerId: string;
  capabilitySnapshot(): RuntimeCapabilitySnapshot;
}

/**
 * 目录只做定义合并和调用路由，不执行权限或重试。所有 Provider 的实际执行
 * 仍然统一进入 ToolRuntime，避免 MCP 和 Skill 绕过现有安全边界。
 */
export class RuntimeCapabilityCatalog implements ToolRegistryPort {
  readonly definitions: ModelToolDefinition[];
  private readonly byModelName = new Map<string, RuntimeToolProvider>();

  /** 初始化「RuntimeCapabilityCatalog」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(private readonly providers: RuntimeToolProvider[]) {
    const definitions: ModelToolDefinition[] = [];
    for (const provider of providers) {
      for (const definition of provider.definitions) {
        const name = definition.function.name;
        if (this.byModelName.has(name)) {
          throw new Error(`Runtime Tool 模型名称冲突: ${name}`);
        }
        this.byModelName.set(name, provider);
        definitions.push(structuredClone(definition));
      }
    }
    if (definitions.length > PRODUCT_CONFIG.capacity.maxAgentBoundTools) {
      throw new Error(
        `当前 Agent 启用 ${definitions.length} 个 Tool，超过 ${PRODUCT_CONFIG.capacity.maxAgentBoundTools} 个上限`,
      );
    }
    const schemaBytes = Buffer.byteLength(JSON.stringify(definitions));
    if (schemaBytes > PRODUCT_CONFIG.capacity.maxTurnToolSchemaBytes) {
      throw new Error(
        `当前 Agent 的 Tool Schema 共 ${schemaBytes} 字节，超过 ${PRODUCT_CONFIG.capacity.maxTurnToolSchemaBytes} 字节上限`,
      );
    }
    this.definitions = definitions;
  }

  /** 执行「prepare」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
prepare(call: ModelToolCall, fallbackId: string): PreparedToolCall {
    return this.providerFor(call.name).prepare(call, fallbackId);
  }

  /** 执行「execute」主流程，传播取消与失败并在结束时清理临时资源。 */
execute(call: PreparedToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    return this.providerFor(call.name).execute(call, context);
  }

  /** 生成「capabilitySnapshot」不可变视图，隔离后续状态修改并只暴露该层需要的事实。 */
capabilitySnapshot(): RuntimeCapabilitySnapshot {
    const snapshots = this.providers.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(provider) => provider.capabilitySnapshot());
    return {
      tools: snapshots.flatMap(/** 根据已校验输入构建「tools」结果，不额外持有调用方的大对象。 */
(item) => item.tools),
      mcpServers: snapshots.flatMap(/** 执行「mcpServers」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(item) => item.mcpServers),
      skills: snapshots.flatMap(/** 执行「skills」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(item) => item.skills),
    };
  }

  /** 执行「providerFor」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
private providerFor(modelName: string): RuntimeToolProvider {
    const provider = this.byModelName.get(modelName);
    if (!provider) throw new Error(`未知 Runtime Tool: ${modelName}`);
    return provider;
  }
}

/** 根据已校验输入构建「toolSchemaHash」结果，不额外持有调用方的大对象。 */
export function toolSchemaHash(definition: ModelToolDefinition): string {
  return createHash("sha256")
    .update(canonicalJson(definition))
    .digest("hex");
}

/** 判断「canonicalJson」对应条件，只返回判定结果且不修改输入状态。 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .toSorted(/** 执行「map」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
([left], [right]) => left.localeCompare(right))
      .map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
