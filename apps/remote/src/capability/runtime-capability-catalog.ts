import { createHash } from "node:crypto";
import type { ModelToolCall, ModelToolDefinition } from "../model/model-provider.js";
import type {
  PreparedToolCall,
  ToolExecutionContext,
  ToolRegistryPort,
  ToolResult,
} from "../tools/tool-registry.js";
import type { RuntimeCapabilitySnapshot } from "./capability-types.js";

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
    this.definitions = definitions;
  }

  prepare(call: ModelToolCall, fallbackId: string): PreparedToolCall {
    return this.providerFor(call.name).prepare(call, fallbackId);
  }

  execute(call: PreparedToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    return this.providerFor(call.name).execute(call, context);
  }

  capabilitySnapshot(): RuntimeCapabilitySnapshot {
    const snapshots = this.providers.map((provider) => provider.capabilitySnapshot());
    return {
      tools: snapshots.flatMap((item) => item.tools),
      mcpServers: snapshots.flatMap((item) => item.mcpServers),
      skills: snapshots.flatMap((item) => item.skills),
    };
  }

  private providerFor(modelName: string): RuntimeToolProvider {
    const provider = this.byModelName.get(modelName);
    if (!provider) throw new Error(`未知 Runtime Tool: ${modelName}`);
    return provider;
  }
}

export function toolSchemaHash(definition: ModelToolDefinition): string {
  return createHash("sha256")
    .update(canonicalJson(definition))
    .digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
