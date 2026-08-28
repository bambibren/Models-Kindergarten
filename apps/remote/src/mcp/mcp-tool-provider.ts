import { createHash } from "node:crypto";
import type { ToolCallContent, ToolKind } from "@agentclientprotocol/sdk";
import Ajv, { type ValidateFunction } from "ajv";
import type { RuntimeCapabilitySnapshot } from "../capability/capability-types.js";
import type { RuntimeToolProvider } from "../capability/runtime-capability-catalog.js";
import { toolSchemaHash } from "../capability/runtime-capability-catalog.js";
import type { ModelToolCall, ModelToolDefinition } from "../model/model-provider.js";
import {
  canonicalJson,
  modelEnvelope,
  type PreparedToolCall,
  type ToolExecutionContext,
  type ToolResult,
} from "../tools/tool-registry.js";
import { ToolExecutionError } from "../tools/tool-error.js";
import { McpRuntimeError, type McpClientManager } from "./mcp-client-manager.js";
import type {
  McpToolBinding,
  McpToolCallResult,
  McpToolDescriptor,
} from "./mcp-types.js";
import { mcpToolCapabilityId } from "./mcp-types.js";
import type { McpBinding } from "@kindergarten/contracts";

const RESOURCE_TOOL = "read_mcp_resource";

/** 描述「McpToolProvider」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export class McpToolProvider implements RuntimeToolProvider {
  readonly providerId = "mcp";
  readonly definitions: ModelToolDefinition[];
  private readonly bindings = new Map<string, McpToolBinding>();
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly resourceIds: Set<string>;

  /** 初始化「McpToolProvider」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(private readonly manager: McpClientManager, agentBindings?: McpBinding[]) {
    const config = manager.config();
    const snapshots = manager.capabilitySnapshots();
    const configured = agentBindings === undefined
      ? new Map(config.agentCapabilities.mcpTools.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => [item.id, item.permission]))
      : new Map(agentBindings.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.enabled).flatMap(/** 执行「configured」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(item) => item.tools
        .filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(tool) => tool.enabled)
        .map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(tool) => [mcpToolCapabilityId(item.mcpInstallationId, tool.remoteName), tool.permission] as const)));
    const ajv = new Ajv({ strict: false, allErrors: true, allowUnionTypes: true });
    for (const snapshot of snapshots) {
      for (const descriptor of snapshot.tools) {
        const capabilityId = mcpToolCapabilityId(snapshot.serverId, descriptor.name);
        const permission = configured.get(capabilityId);
        if (!permission) continue;
        const modelName = modelToolName(snapshot.serverId, descriptor.name);
        if (this.bindings.has(modelName)) throw new Error(`MCP Tool 名称冲突: ${modelName}`);
        const binding: McpToolBinding = {
          capabilityId,
          modelName,
          serverId: snapshot.serverId,
          remoteName: descriptor.name,
          permission,
          descriptor,
        };
        let validator: ValidateFunction;
        try {
          validator = ajv.compile(descriptor.inputSchema);
        } catch (error) {
          throw new Error(`MCP Tool ${capabilityId} 的 inputSchema 无效`, { cause: error });
        }
        this.bindings.set(modelName, binding);
        this.validators.set(modelName, validator);
      }
    }
    const discovered = new Set([...this.bindings.values()].map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.capabilityId));
    for (const capabilityId of configured.keys()) {
      if (!discovered.has(capabilityId)) {
        console.warn(`已配置的 MCP Tool 当前不可用：${capabilityId}`);
      }
    }
    this.resourceIds = new Set(agentBindings === undefined
      ? config.agentCapabilities.resources.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => resourceKey(item.serverId, item.uri))
      : agentBindings.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.enabled).flatMap(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(item) => item.resources
        .filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(resource) => resource.enabled)
        .map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(resource) => resourceKey(item.mcpInstallationId, resource.uri))));
    this.definitions = [
      ...[...this.bindings.values()].map(toDefinition),
      ...(this.resourceIds.size > 0 ? [resourceDefinition()] : []),
    ];
  }

  /** 执行「prepare」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
prepare(call: ModelToolCall, fallbackId: string): PreparedToolCall {
    if (call.name === RESOURCE_TOOL) return this.prepareResource(call, fallbackId);
    const binding = this.bindings.get(call.name);
    if (!binding) throw new Error(`当前 AgentVersion 未绑定 MCP Tool: ${call.name}`);
    const validator = this.validators.get(call.name)!;
    const valid = validator(call.arguments);
    const kind = toolKind(binding.descriptor);
    return {
      id: call.id ?? fallbackId,
      name: call.name,
      title: binding.descriptor.title ?? binding.remoteName,
      kind,
      arguments: structuredClone(call.arguments),
      permission: binding.permission,
      locations: [],
      dedupeKey: `${binding.capabilityId}:${canonicalJson(call.arguments)}`,
      retry: "none",
      ...(!valid ? { validationError: ajvErrorText(validator) } : {}),
    };
  }

  /** 执行「execute」主流程，传播取消与失败并在结束时清理临时资源。 */
async execute(call: PreparedToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    if (call.name === RESOURCE_TOOL) return this.executeResource(call, context);
    const binding = this.bindings.get(call.name);
    if (!binding) throw new Error(`当前 AgentVersion 未绑定 MCP Tool: ${call.name}`);
    let result: McpToolCallResult;
    try {
      result = await this.manager.callTool(
        binding.serverId,
        binding.remoteName,
        call.arguments,
        call.id,
        { askUser: context.askUser },
        context.signal,
      );
    } catch (error) {
      throw toToolError(error);
    }
    const rawOutput = {
      serverId: binding.serverId,
      remoteName: binding.remoteName,
      isError: result.isError,
      structuredContent: result.structuredContent,
      content: result.content,
    };
    if (result.isError) {
      throw new ToolExecutionError(
        "mcp_remote_tool_error",
        "execution",
        contentText(result.content) || `MCP Tool ${binding.remoteName} 执行失败`,
        false,
        rawOutput,
      );
    }
    return {
      modelContent: modelEnvelope(call, true, {
        structuredContent: result.structuredContent,
        content: result.content,
      }),
      rawOutput,
      content: toAcpContent(result.content),
      locations: [],
    };
  }

  /** 生成「capabilitySnapshot」不可变视图，隔离后续状态修改并只暴露该层需要的事实。 */
capabilitySnapshot(): RuntimeCapabilitySnapshot {
    const snapshots = this.manager.capabilitySnapshots();
    return {
      tools: this.definitions.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(definition) => {
        const binding = this.bindings.get(definition.function.name);
        return {
          id: binding?.capabilityId ?? "mcp:host:tool:read_resource",
          modelName: definition.function.name,
          origin: "mcp",
          schemaHash: toolSchemaHash(definition),
          ...(binding ? { serverId: binding.serverId, remoteName: binding.remoteName } : {}),
        };
      }),
      mcpServers: snapshots.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(snapshot) => ({
        serverId: snapshot.serverId,
        protocolEra: this.manager.serverStates().find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.serverId === snapshot.serverId)?.protocolEra ?? "legacy",
        revision: snapshot.revision,
        toolSchemaHashes: Object.fromEntries(snapshot.tools.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(tool) => [
          tool.name,
          createHash("sha256").update(canonicalJson(tool.inputSchema)).digest("hex"),
        ])),
      })),
      skills: [],
    };
  }

  /** 执行「prepareResource」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
private prepareResource(call: ModelToolCall, fallbackId: string): PreparedToolCall {
    const serverId = stringArg(call.arguments.server_id, "server_id");
    const uri = stringArg(call.arguments.uri, "uri");
    const allowed = this.resourceIds.has(resourceKey(serverId, uri));
    const server = this.manager.serverConfig(serverId);
    return {
      id: call.id ?? fallbackId,
      name: RESOURCE_TOOL,
      title: `读取 MCP Resource ${uri}`,
      kind: "read",
      arguments: { server_id: serverId, uri },
      permission: server.trust === "approved" ? "allow" : "ask",
      locations: [],
      dedupeKey: `mcp-resource:${resourceKey(serverId, uri)}`,
      retry: "none",
      ...(!allowed ? { validationError: "当前 AgentVersion 未绑定该 MCP Resource" } : {}),
    };
  }

  /** 执行「executeResource」主流程，传播取消与失败并在结束时清理临时资源。 */
private async executeResource(call: PreparedToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const serverId = String(call.arguments.server_id);
    const uri = String(call.arguments.uri);
    try {
      const result = await this.manager.readResource(serverId, uri, context.signal);
      return {
        modelContent: modelEnvelope(call, true, { serverId, uri, contents: result.contents }),
        rawOutput: { serverId, uri, contents: result.contents },
        content: result.contents.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(resource) => ({
          type: "content",
          content: { type: "resource", resource },
        })) as ToolCallContent[],
        locations: [],
      };
    } catch (error) {
      throw toToolError(error);
    }
  }
}

/** 根据已校验输入构建「toDefinition」结果，不额外持有调用方的大对象。 */
function toDefinition(binding: McpToolBinding): ModelToolDefinition {
  return {
    type: "function",
    function: {
      name: binding.modelName,
      description: binding.descriptor.description ?? `MCP Tool ${binding.remoteName}`,
      parameters: structuredClone(binding.descriptor.inputSchema) as ModelToolDefinition["function"]["parameters"],
    },
  };
}

/** 执行「resourceDefinition」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function resourceDefinition(): ModelToolDefinition {
  return {
    type: "function",
    function: {
      name: RESOURCE_TOOL,
      description: "读取当前 AgentVersion 已绑定的 MCP Resource；只能使用上下文目录中明确列出的 server_id 和 uri。",
      parameters: {
        type: "object",
        properties: {
          server_id: { type: "string", description: "Resource 所属 MCP Server ID" },
          uri: { type: "string", description: "Resource URI" },
        },
        required: ["server_id", "uri"],
        additionalProperties: false,
      },
    },
  };
}

/** 执行「modelToolName」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function modelToolName(serverId: string, remoteName: string): string {
  const base = `mcp__${slug(serverId)}__${slug(remoteName)}`;
  if (base.length <= 64) return base;
  const hash = createHash("sha256").update(`${serverId}:${remoteName}`).digest("hex").slice(0, 8);
  return `${base.slice(0, 55)}_${hash}`;
}

/** 执行「slug」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function slug(value: string): string {
  const result = value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return result || "tool";
}

/** 根据已校验输入构建「toolKind」结果，不额外持有调用方的大对象。 */
function toolKind(descriptor: McpToolDescriptor): ToolKind {
  if (descriptor.annotations?.readOnlyHint === true) return "read";
  if (descriptor.annotations?.destructiveHint === true) return "delete";
  return "other";
}

/** 根据已校验输入构建「toAcpContent」结果，不额外持有调用方的大对象。 */
function toAcpContent(content: McpToolCallResult["content"]): ToolCallContent[] {
  return content.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => ({ type: "content", content: structuredClone(item) })) as ToolCallContent[];
}

/** 执行「contentText」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function contentText(content: McpToolCallResult["content"]): string {
  return content.flatMap(/** 执行「join」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(item) => item.type === "text" && typeof item.text === "string" ? [item.text] : []).join("\n");
}

/** 执行「ajvErrorText」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function ajvErrorText(validator: ValidateFunction): string {
  return (validator.errors ?? []).map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(error) => `${error.instancePath || "/"} ${error.message ?? "无效"}`).join("; ");
}

/** 执行「stringArg」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function stringArg(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} 必须是非空字符串`);
  return value;
}

/** 由规范字段生成稳定的「resourceKey」标识，供索引精确定位且不保留原始大对象。 */
function resourceKey(serverId: string, uri: string): string {
  return `${serverId}\u0000${uri}`;
}

/** 根据已校验输入构建「toToolError」结果，不额外持有调用方的大对象。 */
function toToolError(error: unknown): ToolExecutionError {
  if (error instanceof ToolExecutionError) return error;
  if (error instanceof McpRuntimeError) {
    const category = error.failure.category === "authentication"
      ? "authentication"
      : error.failure.category === "transport"
        ? "network"
        : error.failure.category === "validation"
          ? "validation"
          : "protocol";
    return new ToolExecutionError(
      `mcp_${error.failure.category}`,
      category,
      error.failure.message,
      error.failure.retryable,
    );
  }
  return new ToolExecutionError("mcp_execution_failed", "execution", errorText(error), false);
}

/** 把未知异常转换为「errorText」文本，避免错误序列化过程再次抛出。 */
function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
