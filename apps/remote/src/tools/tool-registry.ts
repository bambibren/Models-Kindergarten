import type { ToolCallContent, ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk";
import { createHash } from "node:crypto";
import { relative } from "node:path";
import { PRODUCT_CONFIG } from "@kindergarten/contracts";
import type { RuntimeCapabilitySnapshot } from "../capability/capability-types.js";
import type { ModelToolCall, ModelToolDefinition, ModelToolSchema } from "../model/model-provider.js";
import { ProcessSandbox } from "./process-sandbox.js";
import { FileSandbox } from "./sandbox.js";
import { WebAccess, type WebToolClient } from "./web-access.js";
import { ToolExecutionError } from "./tool-error.js";

export type PermissionMode = "allow" | "ask" | "always_ask" | "deny";
export type ToolOutcomeStatus = "success" | "error" | "denied" | "duplicate_blocked";
export type ToolErrorCategory =
  | "validation"
  | "permission"
  | "authentication"
  | "protocol"
  | "timeout"
  | "network"
  | "execution"
  | "resource_limit"
  | "dependency_unavailable";

export interface ToolExactArgumentCorrection {
  message: string;
  exactRetryArguments: Record<string, unknown>;
}

export interface ToolSchemaValidationError {
  keyword: string;
  instancePath: string;
  parameter?: string;
  message: string;
}

export interface ToolSchemaCorrection {
  message: string;
  expectedSchema: ModelToolSchema;
}

export interface ToolValidationError {
  message: string;
  validationErrors?: ToolSchemaValidationError[];
  argumentCorrection?: ToolExactArgumentCorrection;
  schemaCorrection?: ToolSchemaCorrection;
  instruction?: string;
}

export interface PreparedToolCall {
  id: string;
  name: ToolName | string;
  title: string;
  kind: ToolKind;
  arguments: Record<string, unknown>;
  permission: PermissionMode;
  locations: ToolCallLocation[];
  dedupeKey: string;
  retry: "none" | "transient";
  validationError?: string | ToolValidationError;
}

export interface ToolExecutionContext {
  askUser(question: string, toolCallId: string): Promise<string>;
  signal: AbortSignal;
}

export interface ToolResult {
  modelContent: string;
  rawOutput: unknown;
  content: ToolCallContent[];
  locations: ToolCallLocation[];
  effects?: {
    capabilitiesChanged?: boolean;
    fileRelativePaths?: string[];
  };
}

/** ToolRuntime 依赖的最小端口；内置、MCP 和 Skill Provider 使用同一条执行链。 */
export interface ToolRegistryPort {
  readonly definitions: ModelToolDefinition[];
  prepare(call: ModelToolCall, fallbackId: string): PreparedToolCall;
  execute(call: PreparedToolCall, context: ToolExecutionContext): Promise<ToolResult>;
  capabilitySnapshot(): RuntimeCapabilitySnapshot;
}

export interface ToolOutcome extends ToolResult {
  status: ToolOutcomeStatus;
  retryable: boolean;
  error?: {
    code: string;
    category: ToolErrorCategory;
    message: string;
  };
}

export type ToolName =
  | "list_files"
  | "read_file"
  | "write_file"
  | "run_command"
  | "web_search"
  | "web_fetch"
  | "ask_user";

/** Registry 只拥有 Tool Schema、参数规范化和具体 Handler。 */
export class ToolRegistry implements ToolRegistryPort {
  readonly providerId = "builtin";
  readonly definitions: ModelToolDefinition[];
  readonly process: ProcessSandbox;
  readonly web: WebToolClient;

  constructor(
    readonly sandbox: FileSandbox,
    process?: ProcessSandbox,
    web?: WebToolClient,
    private readonly bindings?: Map<string, { enabled: boolean; permission: "allow" | "ask" | "deny" }>,
  ) {
    this.process = process ?? new ProcessSandbox(sandbox);
    this.web = web ?? new WebAccess();
    this.definitions = definitions.filter((definition) => this.bindings === undefined || this.bindings.get(definition.function.name)?.enabled === true);
  }

  prepare(call: ModelToolCall, fallbackId: string): PreparedToolCall {
    const name = toolName(call.name);
    if (!this.definitions.some((item) => item.function.name === name)) {
      throw new Error(`当前 Agent 未启用 Built-in Tool: ${name}`);
    }
    const id = call.id ?? fallbackId;
    if (name === "list_files") {
      const path = optionalStringArg(call.arguments, "path") ?? ".";
      return prepared(id, name, `列出 ${path}`, "read", { path }, this.permission(name, "allow"), [], "none");
    }
    if (name === "read_file") {
      const path = stringArg(call.arguments, "path");
      return prepared(id, name, `读取 ${path}`, "read", { path }, "allow", [
        { path: this.sandbox.preview(path) },
      ], "none", this.permission(name, "allow"));
    }
    if (name === "write_file") {
      const path = stringArg(call.arguments, "path");
      const content = stringArg(call.arguments, "content", true);
      return prepared(id, name, `写入 ${path}`, "edit", { path, content }, "ask", [
        { path: this.sandbox.preview(path) },
      ], "none", this.permission(name, "ask"));
    }
    if (name === "run_command") {
      const command = stringArg(call.arguments, "command");
      const cwd = optionalStringArg(call.arguments, "cwd") ?? ".";
      const timeoutMs = optionalNumberArg(call.arguments, "timeout_ms");
      return prepared(
        id,
        name,
        `运行 ${short(command, 60)}`,
        "execute",
        { command, cwd, ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }) },
        this.permission(name, "always_ask"),
        [],
        "none",
      );
    }
    if (name === "web_search") {
      const query = stringArg(call.arguments, "query");
      const maxResults = optionalNumberArg(call.arguments, "max_results") ??
        PRODUCT_CONFIG.tools.web.defaultSearchResults;
      return prepared(id, name, `搜索 ${short(query, 60)}`, "search", {
        query,
        max_results: maxResults,
      }, this.permission(name, "allow"), [], "transient");
    }
    if (name === "web_fetch") {
      const url = stringArg(call.arguments, "url");
      return prepared(id, name, `读取 ${short(url, 72)}`, "fetch", { url }, this.permission(name, "allow"), [], "transient");
    }
    const question = stringArg(call.arguments, "question");
    return prepared(id, name, "询问用户", "other", { question }, this.permission(name, "allow"), [], "none");
  }

  async execute(call: PreparedToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    if (context.signal.aborted) throw new DOMException("已取消", "AbortError");
    if (call.name === "list_files") {
      const items = await this.sandbox.list(String(call.arguments.path));
      return result(call, { items }, JSON.stringify(items, null, 2));
    }
    if (call.name === "read_file") {
      const value = await this.sandbox.readText(String(call.arguments.path));
      return result(call, { path: value.path, content: value.content }, value.content, [{ path: value.path }]);
    }
    if (call.name === "write_file") {
      const value = await this.sandbox.writeText(
        String(call.arguments.path),
        String(call.arguments.content),
      );
      const rawOutput = { path: value.path, bytes: Buffer.byteLength(value.newText, "utf8") };
      return {
        modelContent: modelEnvelope(call, true, rawOutput),
        rawOutput,
        content: [{ type: "diff", path: value.path, oldText: value.oldText, newText: value.newText }],
        locations: [{ path: value.path }],
        effects: { fileRelativePaths: [relative(this.sandbox.root, value.path).split("\\").join("/")] },
      };
    }
    if (call.name === "run_command") {
      const value = await this.process.run(
        String(call.arguments.command),
        optionalStringArg(call.arguments, "cwd"),
        optionalNumberArg(call.arguments, "timeout_ms"),
        context.signal,
      );
      if (value.exitCode !== 0) {
        throw new ToolExecutionError(
          "command_failed",
          "execution",
          `命令执行失败（exit ${value.exitCode ?? "signal"}）`,
          false,
          value,
        );
      }
      return result(call, value, modelEnvelope(call, true, value));
    }
    if (call.name === "web_search") {
      const items = await this.web.search(
        String(call.arguments.query),
        Number(call.arguments.max_results),
        context.signal,
      );
      return result(call, { results: items }, modelEnvelope(call, true, { results: items }));
    }
    if (call.name === "web_fetch") {
      const value = await this.web.fetch(String(call.arguments.url), context.signal);
      return result(call, value, modelEnvelope(call, true, value));
    }
    if (call.name === "ask_user") {
      const answer = await context.askUser(String(call.arguments.question), call.id);
      return result(call, { answer }, modelEnvelope(call, true, { answer }));
    }
    throw new Error(`未知工具: ${call.name}`);
  }

  capabilitySnapshot(): RuntimeCapabilitySnapshot {
    return {
      tools: this.definitions.map((definition) => ({
        id: `builtin:tool:${definition.function.name}`,
        modelName: definition.function.name,
        origin: "builtin",
        schemaHash: createHash("sha256")
          .update(canonicalJson(definition))
          .digest("hex"),
      })),
      mcpServers: [],
      skills: [],
    };
  }

  private permission(name: string, required: PermissionMode): PermissionMode {
    const configured = this.bindings?.get(name)?.permission;
    if (configured === "deny") return "deny";
    if (required === "always_ask") return "always_ask";
    if (required === "ask") return configured ?? "ask";
    return configured ?? required;
  }
}

function prepared(
  id: string,
  name: ToolName,
  title: string,
  kind: ToolKind,
  args: Record<string, unknown>,
  permission: PermissionMode,
  locations: ToolCallLocation[],
  retry: PreparedToolCall["retry"],
  permissionOverride?: PermissionMode,
): PreparedToolCall {
  return {
    id,
    name,
    title,
    kind,
    arguments: args,
    permission: permissionOverride ?? permission,
    locations,
    dedupeKey: `${name}:${canonicalJson(args)}`,
    retry,
  };
}

function result(
  call: PreparedToolCall,
  rawOutput: unknown,
  text: string,
  locations: ToolCallLocation[] = call.locations,
): ToolResult {
  return {
    modelContent: text.startsWith("{") ? text : modelEnvelope(call, true, rawOutput, text),
    rawOutput,
    content: [{ type: "content", content: { type: "text", text } }],
    locations,
  };
}

export function modelEnvelope(
  call: Pick<PreparedToolCall, "id" | "name">,
  ok: boolean,
  value: unknown,
  text?: string,
  instructionOverride?: string,
): string {
  return JSON.stringify({
    ok,
    tool: call.name,
    toolCallId: call.id,
    ...(ok ? { result: value } : { error: value }),
    ...(text ? { text } : {}),
    instruction: instructionOverride ?? (ok
      ? "The tool operation completed."
      : "The tool operation did not complete. Do not repeat identical arguments."),
  });
}

const definitions: ModelToolDefinition[] = [
  definition("list_files", "列出沙箱目录中的文件和子目录。", {
    path: { type: "string", description: "相对目录，默认 ." },
  }),
  definition("read_file", "读取沙箱中的 UTF-8 文本文件。", {
    path: { type: "string", description: "沙箱内相对 POSIX 路径" },
  }, ["path"]),
  definition("write_file", "创建或完整覆盖沙箱中的 UTF-8 文本文件，执行前需要用户授权。", {
    path: { type: "string", description: "沙箱内相对 POSIX 路径" },
    content: { type: "string", description: "完整文件内容" },
  }, ["path", "content"]),
  definition("run_command", "在受限 macOS 沙箱中运行终端命令。每次执行都需要用户授权。", {
    command: { type: "string", description: "要运行的单条 shell 命令" },
    cwd: { type: "string", description: "沙箱内相对工作目录，默认 ." },
    timeout_ms: {
      type: "integer",
      description: `超时毫秒，最大 ${PRODUCT_CONFIG.tools.process.maxTimeoutMs}`,
    },
  }, ["command"]),
  definition("web_search", "搜索公开网页并返回标题和 URL。", {
    query: { type: "string", description: "搜索关键词" },
    max_results: {
      type: "integer",
      description: `返回结果数，${PRODUCT_CONFIG.tools.web.minSearchResults} 到 ${PRODUCT_CONFIG.tools.web.maxSearchResults}`,
    },
  }, ["query"]),
  definition("web_fetch", "读取一个公开 http/https 网页的正文，拒绝本机和私有网络地址。", {
    url: { type: "string", description: "公开网页 URL" },
  }, ["url"]),
  definition("ask_user", "确实缺少必要信息时，通过 ACP 表单询问一个明确问题。", {
    question: { type: "string", description: "需要用户回答的单个问题" },
  }, ["question"]),
];

function definition(
  name: ToolName,
  description: string,
  properties: Record<string, unknown>,
  required?: string[],
): ModelToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties, ...(required ? { required } : {}), additionalProperties: false },
    },
  };
}

function toolName(value: string): ToolName {
  const names: ToolName[] = [
    "list_files", "read_file", "write_file", "run_command",
    "web_search", "web_fetch", "ask_user",
  ];
  if (names.includes(value as ToolName)) return value as ToolName;
  throw new Error(`未知工具: ${value}`);
}

function stringArg(input: Record<string, unknown>, name: string, allowEmpty = false): string {
  const value = input[name];
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    throw new Error(`${name} 必须是${allowEmpty ? "" : "非空"}字符串`);
  }
  return value;
}

function optionalStringArg(input: Record<string, unknown>, name: string): string | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  return stringArg(input, name);
}

function optionalNumberArg(input: Record<string, unknown>, name: string): number | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} 必须是数字`);
  return value;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function short(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}
