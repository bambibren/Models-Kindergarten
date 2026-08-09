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

const RESOURCE_TOOL = "read_mcp_resource";

export class McpToolProvider implements RuntimeToolProvider {
  readonly providerId = "mcp";
  readonly definitions: ModelToolDefinition[];
  private readonly bindings = new Map<string, McpToolBinding>();
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly resourceIds: Set<string>;

  constructor(private readonly manager: McpClientManager) {
    const config = manager.config();
    const snapshots = manager.capabilitySnapshots();
    const configured = new Map(config.agentCapabilities.mcpTools.map((item) => [item.id, item.permission]));
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
    const discovered = new Set([...this.bindings.values()].map((item) => item.capabilityId));
    for (const capabilityId of configured.keys()) {
      if (!discovered.has(capabilityId)) {
        console.warn(`已配置的 MCP Tool 当前不可用：${capabilityId}`);
      }
    }
    this.resourceIds = new Set(config.agentCapabilities.resources.map((item) => resourceKey(item.serverId, item.uri)));
    this.definitions = [
      ...[...this.bindings.values()].map(toDefinition),
      ...(this.resourceIds.size > 0 ? [resourceDefinition()] : []),
    ];
  }

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

  capabilitySnapshot(): RuntimeCapabilitySnapshot {
    const snapshots = this.manager.capabilitySnapshots();
    return {
      tools: this.definitions.map((definition) => {
        const binding = this.bindings.get(definition.function.name);
        return {
          id: binding?.capabilityId ?? "mcp:host:tool:read_resource",
          modelName: definition.function.name,
          origin: "mcp",
          schemaHash: toolSchemaHash(definition),
          ...(binding ? { serverId: binding.serverId, remoteName: binding.remoteName } : {}),
        };
      }),
      mcpServers: snapshots.map((snapshot) => ({
        serverId: snapshot.serverId,
        protocolEra: this.manager.serverStates().find((item) => item.serverId === snapshot.serverId)?.protocolEra ?? "legacy",
        revision: snapshot.revision,
        toolSchemaHashes: Object.fromEntries(snapshot.tools.map((tool) => [
          tool.name,
          createHash("sha256").update(canonicalJson(tool.inputSchema)).digest("hex"),
        ])),
      })),
      skills: [],
    };
  }

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

  private async executeResource(call: PreparedToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const serverId = String(call.arguments.server_id);
    const uri = String(call.arguments.uri);
    try {
      const result = await this.manager.readResource(serverId, uri, context.signal);
      return {
        modelContent: modelEnvelope(call, true, { serverId, uri, contents: result.contents }),
        rawOutput: { serverId, uri, contents: result.contents },
        content: result.contents.map((resource) => ({
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

function modelToolName(serverId: string, remoteName: string): string {
  const base = `mcp__${slug(serverId)}__${slug(remoteName)}`;
  if (base.length <= 64) return base;
  const hash = createHash("sha256").update(`${serverId}:${remoteName}`).digest("hex").slice(0, 8);
  return `${base.slice(0, 55)}_${hash}`;
}

function slug(value: string): string {
  const result = value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return result || "tool";
}

function toolKind(descriptor: McpToolDescriptor): ToolKind {
  if (descriptor.annotations?.readOnlyHint === true) return "read";
  if (descriptor.annotations?.destructiveHint === true) return "delete";
  return "other";
}

function toAcpContent(content: McpToolCallResult["content"]): ToolCallContent[] {
  return content.map((item) => ({ type: "content", content: structuredClone(item) })) as ToolCallContent[];
}

function contentText(content: McpToolCallResult["content"]): string {
  return content.flatMap((item) => item.type === "text" && typeof item.text === "string" ? [item.text] : []).join("\n");
}

function ajvErrorText(validator: ValidateFunction): string {
  return (validator.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "无效"}`).join("; ");
}

function stringArg(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} 必须是非空字符串`);
  return value;
}

function resourceKey(serverId: string, uri: string): string {
  return `${serverId}\u0000${uri}`;
}

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

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
