import type { RuntimeCapabilitySnapshot } from "../capability/capability-types.js";
import { toolSchemaHash, type RuntimeToolProvider } from "../capability/runtime-capability-catalog.js";
import type { ModelToolCall, ModelToolDefinition } from "../model/model-provider.js";
import {
  canonicalJson,
  modelEnvelope,
  type PreparedToolCall,
  type ToolExecutionContext,
  type ToolResult,
} from "../tools/tool-registry.js";
import type { SkillRegistry } from "./skill-registry.js";

const ACTIVATE = "activate_skill";
const READ_RESOURCE = "read_skill_resource";

export class SkillToolProvider implements RuntimeToolProvider {
  readonly providerId = "skill-runtime";
  readonly definitions: ModelToolDefinition[];
  private readonly allowedIds: Set<string>;

  constructor(
    private readonly registry: SkillRegistry,
    skillIds: string[],
  ) {
    registry.selected(skillIds);
    this.allowedIds = new Set(skillIds);
    this.definitions = skillIds.length > 0 ? definitions : [];
  }

  prepare(call: ModelToolCall, fallbackId: string): PreparedToolCall {
    if (call.name !== ACTIVATE && call.name !== READ_RESOURCE) {
      throw new Error(`未知 Skill Runtime Tool: ${call.name}`);
    }
    const skillId = stringArg(call.arguments.skill_id, "skill_id");
    const path = call.name === READ_RESOURCE
      ? stringArg(call.arguments.path, "path")
      : undefined;
    return {
      id: call.id ?? fallbackId,
      name: call.name,
      title: call.name === ACTIVATE ? `激活 ${skillId}` : `读取 ${skillId}/${path}`,
      kind: "read",
      arguments: { skill_id: skillId, ...(path ? { path } : {}) },
      permission: "allow",
      locations: [],
      dedupeKey: `skill:${call.name}:${canonicalJson(call.arguments)}`,
      retry: "none",
      ...(!this.allowedIds.has(skillId) ? { validationError: `当前 AgentVersion 未绑定 Skill: ${skillId}` } : {}),
    };
  }

  async execute(call: PreparedToolCall, _context: ToolExecutionContext): Promise<ToolResult> {
    const skillId = String(call.arguments.skill_id);
    if (call.name === ACTIVATE) {
      const value = this.registry.instructions(skillId, this.allowedIds);
      const rawOutput = {
        skillId,
        contentHash: value.record.contentHash,
        instructions: value.content,
      };
      return {
        modelContent: modelEnvelope(call, true, rawOutput),
        rawOutput,
        content: [{ type: "content", content: { type: "text", text: value.content } }],
        locations: [],
      };
    }
    const value = await this.registry.readResource(skillId, String(call.arguments.path), this.allowedIds);
    const rawOutput = {
      skillId,
      contentHash: value.record.contentHash,
      path: value.path,
      content: value.content,
    };
    return {
      modelContent: modelEnvelope(call, true, rawOutput),
      rawOutput,
      content: [{ type: "content", content: { type: "text", text: value.content } }],
      locations: [],
    };
  }

  capabilitySnapshot(): RuntimeCapabilitySnapshot {
    return {
      tools: this.definitions.map((definition) => ({
        id: `skill-runtime:tool:${definition.function.name}`,
        modelName: definition.function.name,
        origin: "skill_runtime",
        schemaHash: toolSchemaHash(definition),
      })),
      mcpServers: [],
      skills: this.registry.selected([...this.allowedIds]).map((skill) => ({
        skillId: skill.id,
        contentHash: skill.contentHash,
        source: skill.source.kind,
      })),
    };
  }
}

const definitions: ModelToolDefinition[] = [
  {
    type: "function",
    function: {
      name: ACTIVATE,
      description: "当任务与可用 Skill 描述匹配时，读取该 Skill 的完整执行指令。每个 Skill 在同一 Turn 只需激活一次。",
      parameters: {
        type: "object",
        properties: { skill_id: { type: "string", description: "上下文可用 Skill 目录中的稳定 ID" } },
        required: ["skill_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: READ_RESOURCE,
      description: "读取已绑定 Skill 在 references、assets 或 scripts 中明确引用的文本资源；不会执行脚本。",
      parameters: {
        type: "object",
        properties: {
          skill_id: { type: "string" },
          path: { type: "string", description: "相对 Skill 根目录的文件路径" },
        },
        required: ["skill_id", "path"],
        additionalProperties: false,
      },
    },
  },
];

function stringArg(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} 必须是非空字符串`);
  return value;
}
