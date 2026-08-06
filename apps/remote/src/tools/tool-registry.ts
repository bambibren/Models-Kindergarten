import type { ToolKind, ToolCallContent, ToolCallLocation } from "@agentclientprotocol/sdk";
import type {
  ModelToolDefinition,
  ModelToolCall,
} from "../model/model-provider.js";
import { FileSandbox } from "./sandbox.js";

export type ToolPermission = "none" | "write";

export interface PreparedToolCall {
  id: string;
  name: string;
  title: string;
  kind: ToolKind;
  arguments: Record<string, unknown>;
  permission: ToolPermission;
  locations: ToolCallLocation[];
  validationError?: string;
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
}

type ToolName = "read_file" | "write_file" | "ask_user";

/** Tool Schema、参数校验和实际执行只有这一个入口。 */
export class ToolRegistry {
  readonly definitions: ModelToolDefinition[] = definitions;

  constructor(readonly sandbox: FileSandbox) {}

  prepare(call: ModelToolCall, fallbackId: string): PreparedToolCall {
    const name = toolName(call.name);
    // Ollama 的 call id 只属于一次模型响应；ACP toolCallId 由 Agent 生成并保证会话内唯一。
    const id = fallbackId;
    if (name === "read_file") {
      const path = stringArg(call.arguments, "path");
      return {
        id,
        name,
        title: `读取 ${path}`,
        kind: "read",
        arguments: { path },
        permission: "none",
        locations: [{ path: this.sandbox.preview(path) }],
      };
    }
    if (name === "write_file") {
      const path = stringArg(call.arguments, "path");
      const content = stringArg(call.arguments, "content", true);
      return {
        id,
        name,
        title: `写入 ${path}`,
        kind: "edit",
        arguments: { path, content },
        permission: "write",
        locations: [{ path: this.sandbox.preview(path) }],
      };
    }
    const question = stringArg(call.arguments, "question");
    return {
      id,
      name,
      title: "询问用户",
      kind: "other",
      arguments: { question },
      permission: "none",
      locations: [],
    };
  }

  async execute(call: PreparedToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    if (context.signal.aborted) throw new DOMException("已取消", "AbortError");

    if (call.name === "read_file") {
      const result = await this.sandbox.readText(String(call.arguments.path));
      return {
        modelContent: result.content,
        rawOutput: { path: result.path, content: result.content },
        content: [{ type: "content", content: { type: "text", text: result.content } }],
        locations: [{ path: result.path }],
      };
    }
    if (call.name === "write_file") {
      const result = await this.sandbox.writeText(
        String(call.arguments.path),
        String(call.arguments.content),
      );
      return {
        modelContent: `已写入 ${call.arguments.path}`,
        rawOutput: { path: result.path, bytes: Buffer.byteLength(result.newText, "utf8") },
        content: [{
          type: "diff",
          path: result.path,
          oldText: result.oldText,
          newText: result.newText,
        }],
        locations: [{ path: result.path }],
      };
    }

    if (call.name === "ask_user") {
      const answer = await context.askUser(String(call.arguments.question), call.id);
      return {
        modelContent: answer,
        rawOutput: { answer },
        content: [{ type: "content", content: { type: "text", text: answer } }],
        locations: [],
      };
    }
    throw new Error(`未知工具: ${call.name}`);
  }
}

const definitions: ModelToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读取 Models Kindergarten 沙箱中的 UTF-8 文本文件。path 必须是相对路径。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "沙箱内相对 POSIX 路径，例如 notes/today.md" },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "在 Models Kindergarten 沙箱中创建或完整覆盖 UTF-8 文本文件。执行前需要用户授权。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "沙箱内相对 POSIX 路径" },
          content: { type: "string", description: "要写入的完整文件内容" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_user",
      description: "当完成任务确实缺少用户信息时，通过 ACP 表单询问一个明确问题并等待回答。",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "需要用户回答的单个明确问题" },
        },
        required: ["question"],
        additionalProperties: false,
      },
    },
  },
];

function toolName(value: string): ToolName {
  if (value === "read_file" || value === "write_file" || value === "ask_user") {
    return value;
  }
  throw new Error(`未知工具: ${value}`);
}

function stringArg(
  input: Record<string, unknown>,
  name: string,
  allowEmpty = false,
): string {
  const value = input[name];
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    throw new Error(`${name} 必须是${allowEmpty ? "" : "非空"}字符串`);
  }
  return value;
}
