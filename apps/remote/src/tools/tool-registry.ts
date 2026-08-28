import type { ToolCallContent, ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk";
import { createHash } from "node:crypto";
import { relative } from "node:path";
import { PRODUCT_CONFIG } from "@kindergarten/contracts";
import type { RuntimeCapabilitySnapshot } from "../capability/capability-types.js";
import type { ModelToolCall, ModelToolDefinition, ModelToolSchema } from "../model/model-provider.js";
import { ProcessSandbox } from "./process-sandbox.js";
import { FileSandbox, type SandboxTextEdit } from "./sandbox.js";
import { WebAccess, type WebToolClient } from "./web-access.js";
import { ToolExecutionError } from "./tool-error.js";

/** 描述「PermissionMode」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type PermissionMode = "allow" | "ask" | "always_ask" | "deny";
/** 描述「ToolOutcomeStatus」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ToolOutcomeStatus = "success" | "error" | "denied" | "duplicate_blocked";
/** 描述「ToolErrorCategory」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
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

/** 描述「ToolExactArgumentCorrection」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ToolExactArgumentCorrection {
  message: string;
  exactRetryArguments: Record<string, unknown>;
}

/** 描述「ToolSchemaValidationError」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ToolSchemaValidationError {
  keyword: string;
  instancePath: string;
  parameter?: string;
  message: string;
}

/** 描述「ToolSchemaCorrection」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ToolSchemaCorrection {
  message: string;
  expectedSchema: ModelToolSchema;
}

/** 描述「ToolValidationError」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ToolValidationError {
  message: string;
  validationErrors?: ToolSchemaValidationError[];
  argumentCorrection?: ToolExactArgumentCorrection;
  schemaCorrection?: ToolSchemaCorrection;
  instruction?: string;
}

/** 描述「PreparedToolCall」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
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

/** 描述「ToolExecutionContext」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ToolExecutionContext {
  askUser(question: string, toolCallId: string): Promise<string>;
  signal: AbortSignal;
}

/** 描述「ToolResult」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
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

/** 描述「ToolOutcome」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface ToolOutcome extends ToolResult {
  status: ToolOutcomeStatus;
  retryable: boolean;
  error?: {
    code: string;
    category: ToolErrorCategory;
    message: string;
  };
}

/** 描述「ToolName」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export type ToolName =
  | "list_files"
  | "read_file"
  | "write_file"
  | "edit_file"
  | "run_command"
  | "web_search"
  | "web_fetch"
  | "ask_user";

// 终端实现暂时保留，便于以后恢复；当前产品阶段统一在 Registry 出口短路，
// 不进入模型 Tool Schema，也不进入 Agent 能力配置。
const EXPOSE_RUN_COMMAND_TOOL = false;

/** Registry 只拥有 Tool Schema、参数规范化和具体 Handler。 */
export class ToolRegistry implements ToolRegistryPort {
  readonly providerId = "builtin";
  readonly definitions: ModelToolDefinition[];
  readonly process: ProcessSandbox;
  readonly web: WebToolClient;

  /** 初始化「ToolRegistry」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(
    readonly sandbox: FileSandbox,
    process?: ProcessSandbox,
    web?: WebToolClient,
    private readonly bindings?: Map<string, { enabled: boolean; permission: "allow" | "ask" | "deny" }>,
  ) {
    this.process = process ?? new ProcessSandbox(sandbox);
    this.web = web ?? new WebAccess();
    this.definitions = definitions.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(definition) =>
      (EXPOSE_RUN_COMMAND_TOOL || definition.function.name !== "run_command") &&
      (this.bindings === undefined || this.binding(definition.function.name)?.enabled === true));
  }

  /** 执行「prepare」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
prepare(call: ModelToolCall, fallbackId: string): PreparedToolCall {
    const name = toolName(call.name);
    if (!this.definitions.some(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.function.name === name)) {
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
      return prepared(id, name, `写入 ${path}`, "edit", { path, content }, "ask", [], "none", this.permission(name, "ask"));
    }
    if (name === "edit_file") {
      const path = stringArg(call.arguments, "path");
      const edits = textEditsArg(call.arguments, "edits");
      return prepared(id, name, `按行替换 ${path}`, "edit", { path, edits }, "ask", [], "none", this.permission(name, "ask"));
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

  /** 执行「execute」主流程，传播取消与失败并在结束时清理临时资源。 */
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
        modelContent: modelEnvelope(call, true, rawOutput, undefined,
          "The file exists only in the Session Workspace and is not published, deliverable, or previewable. If the user requested a file, continue by calling publish_artifact or publish_artifact_version as appropriate; do not finish yet."),
        rawOutput,
        content: [{ type: "diff", path: value.path, oldText: value.oldText, newText: value.newText }],
        locations: [],
        effects: { fileRelativePaths: [relative(this.sandbox.root, value.path).split("\\").join("/")] },
      };
    }
    if (call.name === "edit_file") {
      const value = await this.sandbox.editText(
        String(call.arguments.path),
        call.arguments.edits as SandboxTextEdit[],
      );
      const rawOutput = { path: value.path, bytes: value.bytes, replacements: value.replacements };
      return {
        modelContent: modelEnvelope(call, true, rawOutput, undefined,
          "The edited file exists only in the Session Workspace and is not published, deliverable, or previewable. If the user requested a file, continue by calling publish_artifact or publish_artifact_version as appropriate; do not finish yet."),
        rawOutput,
        content: [{ type: "diff", path: value.path, oldText: value.oldText, newText: value.newText }],
        locations: [],
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
          value.changedFiles.length > 0
            ? { effects: { fileRelativePaths: value.changedFiles } }
            : undefined,
        );
      }
      return {
        ...result(call, value, modelEnvelope(call, true, value, undefined, value.changedFiles.length > 0
          ? "Files changed by this command exist only in the Session Workspace and are not published, deliverable, or previewable. If the user requested a file, continue by calling the appropriate publish tool; do not finish yet."
          : undefined)),
        ...(value.changedFiles.length > 0
          ? { effects: { fileRelativePaths: value.changedFiles } }
          : {}),
      };
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

  /** 生成「capabilitySnapshot」不可变视图，隔离后续状态修改并只暴露该层需要的事实。 */
capabilitySnapshot(): RuntimeCapabilitySnapshot {
    return {
      tools: this.definitions.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(definition) => ({
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

  /** 执行「permission」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
private permission(name: string, required: PermissionMode): PermissionMode {
    const configured = this.binding(name)?.permission;
    if (configured === "deny") return "deny";
    if (required === "always_ask") return "always_ask";
    if (required === "ask") return configured ?? "ask";
    return configured ?? required;
  }

  /** edit_file 与 write_file 共享启用状态和权限，现有 Agent 无需迁移配置即可使用安全增量编辑。 */
  private binding(name: string): { enabled: boolean; permission: "allow" | "ask" | "deny" } | undefined {
    return this.bindings?.get(name === "edit_file" ? "write_file" : name);
  }
}

/** 执行「prepared」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
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

/** 执行「result」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
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

/** 执行「modelEnvelope」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
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
  definition("write_file", "创建或完整覆盖 Session Workspace 中的 UTF-8 文本文件。此工具只写入工作区，不发布、不交付、也不提供预览；用户要求生成文件时，写入后必须继续调用 publish_artifact 或 publish_artifact_version，发布成功后才能向用户交付。是否询问由当前 Agent permission 配置决定。", {
    path: { type: "string", description: "沙箱内相对 POSIX 路径" },
    content: { type: "string", description: "完整文件内容" },
  }, ["path", "content"]),
  definition("edit_file", "按行替换 Session Workspace 中已有 UTF-8 文本文件的一个或多个片段。每段 old_text 必须按字面值恰好匹配一次；全部片段校验成功后才写入，任一片段失败时文件保持不变。小范围修改已有文件时优先使用此工具，避免用 write_file 重写完整文件。此工具只修改工作区，不发布、不交付、也不提供预览；权限与 write_file 保持一致。", {
    path: { type: "string", description: "沙箱内已有文件的相对 POSIX 路径" },
    edits: {
      type: "array",
      minItems: 1,
      description: "按顺序执行的精确旧文本替换列表",
      items: {
        type: "object",
        properties: {
          old_text: { type: "string", minLength: 1, description: "必须在当前文件内容中恰好出现一次的旧文本片段" },
          new_text: { type: "string", description: "替换后的新文本；允许为空字符串以删除旧片段" },
        },
        required: ["old_text", "new_text"],
        additionalProperties: false,
      },
    },
  }, ["path", "edits"]),
  definition("run_command", "在受限 macOS 沙箱中运行终端命令。命令产生的文件只存在于 Session Workspace，不会自动发布或提供预览；用户要求生成文件时，必须继续调用适用的发布工具。每次执行都需要用户授权。", {
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

/** 执行「definition」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
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

/** 根据已校验输入构建「toolName」结果，不额外持有调用方的大对象。 */
function toolName(value: string): ToolName {
  const names: ToolName[] = [
    "list_files", "read_file", "write_file", "edit_file", "run_command",
    "web_search", "web_fetch", "ask_user",
  ];
  if (names.includes(value as ToolName)) return value as ToolName;
  throw new Error(`未知工具: ${value}`);
}

/** 执行「stringArg」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function stringArg(input: Record<string, unknown>, name: string, allowEmpty = false): string {
  const value = input[name];
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    throw new Error(`${name} 必须是${allowEmpty ? "" : "非空"}字符串`);
  }
  return value;
}

/** 执行「optionalStringArg」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function optionalStringArg(input: Record<string, unknown>, name: string): string | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  return stringArg(input, name);
}

/** 执行「optionalNumberArg」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function optionalNumberArg(input: Record<string, unknown>, name: string): number | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} 必须是数字`);
  return value;
}

/** 校验模型提交的按行替换数组，并把 snake_case Schema 转成沙箱内部合同。 */
function textEditsArg(input: Record<string, unknown>, name: string): SandboxTextEdit[] {
  const value = input[name];
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${name} 必须是非空数组`);
  return value.map(/** 将公开 Tool 参数规范化为内部文本编辑，额外字段由 JSON Schema 拒绝。 */
  (item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${name}[${index}] 必须是对象`);
    }
    const record = item as Record<string, unknown>;
    const unexpected = Object.keys(record).filter(/** 只接受公开 Schema 声明的字段，避免绕过 Provider 侧 JSON Schema 校验。 */
    (key) => key !== "old_text" && key !== "new_text");
    if (unexpected.length > 0) throw new Error(`${name}[${index}] 包含未知字段: ${unexpected.join(", ")}`);
    const oldText = stringArg(record, "old_text", true);
    if (oldText.length === 0) throw new Error(`${name}[${index}].old_text 必须是非空字符串`);
    const newText = stringArg(record, "new_text", true);
    return { oldText, newText };
  });
}

/** 判断「canonicalJson」对应条件，只返回判定结果且不修改输入状态。 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .toSorted(/** 执行「map」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
([a], [b]) => a.localeCompare(b))
      .map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** 执行「short」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function short(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}
