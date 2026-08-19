import { createHash } from "node:crypto";
import type { RuntimeCapabilitySnapshot } from "../capability/capability-types.js";
import type { ModelToolCall, ModelToolDefinition } from "../model/model-provider.js";
import {
  canonicalJson,
  modelEnvelope,
  type PermissionMode,
  type PreparedToolCall,
  type ToolExecutionContext,
  type ToolRegistryPort,
  type ToolResult,
} from "../tools/tool-registry.js";
import type { PptxBuildInput, PptxBuildResult } from "./pptx-build-service.js";

export const PPTX_TOOL_IDS = ["build_pptx"] as const;
type PptxToolName = typeof PPTX_TOOL_IDS[number];

export interface PptxBuilder {
  build(input: PptxBuildInput, signal: AbortSignal): Promise<PptxBuildResult>;
}

export const pptxToolDefinitions: ModelToolDefinition[] = [{
  type: "function",
  function: {
    name: "build_pptx",
    description: "执行当前 Session Workspace 中的 PptxGenJS 源码，并在指定相对路径生成经过基本 OOXML 完整性检查的可编辑 .pptx 文件。运行环境已提供 PptxGenJS 4.0.1；不要初始化 Node 项目、不要创建 package.json、不要安装依赖，也不要为构建 PPTX 请求终端权限。直接编写 PptxGenJS 源码并调用此能力。此能力只负责构建；文件仍留在当前 Workspace，成功发布后才能交付、下载或后续复用。",
    parameters: {
      type: "object",
      properties: {
        source_path: { type: "string", description: "当前 Session Workspace 内的 .js、.cjs 或 .mjs 相对路径" },
        output_path: { type: "string", description: "当前 Session Workspace 内要生成的 .pptx 相对路径" },
      },
      required: ["source_path", "output_path"],
      additionalProperties: false,
    },
  },
}];

export class PptxToolProvider implements ToolRegistryPort {
  readonly providerId = "pptx";
  readonly definitions: ModelToolDefinition[];

  constructor(
    private readonly builder: PptxBuilder,
    private readonly bindings: Map<string, { enabled: boolean; permission: "allow" | "ask" | "deny" }>,
  ) {
    this.definitions = pptxToolDefinitions.filter((item) =>
      this.bindings.get(item.function.name)?.enabled === true,
    );
  }

  prepare(call: ModelToolCall, fallbackId: string): PreparedToolCall {
    const name = toolName(call.name);
    if (!this.definitions.some((item) => item.function.name === name)) {
      throw new Error(`当前 Agent 未启用 PPTX Tool: ${name}`);
    }
    const sourcePath = stringArg(call.arguments, "source_path");
    const outputPath = stringArg(call.arguments, "output_path");
    const args = { source_path: sourcePath, output_path: outputPath };
    return {
      id: call.id ?? fallbackId,
      name,
      title: `构建 ${outputPath}`,
      kind: "execute",
      arguments: args,
      permission: this.permission(name),
      locations: [],
      dedupeKey: `${name}:${canonicalJson(args)}`,
      retry: "none",
    };
  }

  async execute(call: PreparedToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    if (context.signal.aborted) throw new DOMException("已取消", "AbortError");
    const result = await this.builder.build({
      sourcePath: String(call.arguments.source_path),
      outputPath: String(call.arguments.output_path),
    }, context.signal);
    const rawOutput = {
      sourcePath: result.sourcePath,
      outputPath: result.outputPath,
      sha256: result.sha256,
      byteLength: result.byteLength,
      slides: result.slides,
      entries: result.entries,
      ...(result.stderr.trim() ? { stderr: result.stderr } : {}),
      truncated: result.truncated,
    };
    return {
      modelContent: modelEnvelope(
        call,
        true,
        rawOutput,
        undefined,
        "The PPTX was built in the Session Workspace but is not yet deliverable or previewable. Continue with the available Artifact publication capability before finishing the file-generation task.",
      ),
      rawOutput,
      content: [{ type: "content", content: { type: "text", text: JSON.stringify(rawOutput, null, 2) } }],
      locations: [],
      effects: { fileRelativePaths: [result.outputPath] },
    };
  }

  capabilitySnapshot(): RuntimeCapabilitySnapshot {
    return {
      tools: this.definitions.map((definition) => ({
        id: `pptx:tool:${definition.function.name}`,
        modelName: definition.function.name,
        origin: "builtin",
        schemaHash: createHash("sha256").update(canonicalJson(definition)).digest("hex"),
      })),
      mcpServers: [],
      skills: [],
    };
  }

  private permission(name: PptxToolName): PermissionMode {
    return this.bindings.get(name)?.permission ?? "deny";
  }
}

function toolName(value: string): PptxToolName {
  if (PPTX_TOOL_IDS.includes(value as PptxToolName)) return value as PptxToolName;
  throw new Error(`未知 PPTX Tool: ${value}`);
}

function stringArg(input: Record<string, unknown>, name: string): string {
  const value = input[name];
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} 必须是非空字符串`);
  return value;
}
