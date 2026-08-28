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

/** 描述「SkillToolProvider」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export class SkillToolProvider implements RuntimeToolProvider {
  readonly providerId = "skill-runtime";
  readonly definitions: ModelToolDefinition[];
  private readonly allowedNames: Set<string>;

  /** 初始化「SkillToolProvider」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(
    private readonly registry: SkillRegistry,
    skillNames: string[],
  ) {
    registry.selected(skillNames);
    this.allowedNames = new Set(skillNames);
    this.definitions = skillNames.length > 0 ? definitions([...this.allowedNames]) : [];
  }

  /** 执行「prepare」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
prepare(call: ModelToolCall, fallbackId: string): PreparedToolCall {
    if (call.name !== ACTIVATE && call.name !== READ_RESOURCE) {
      throw new Error(`未知 Skill Runtime Tool: ${call.name}`);
    }
    const skillName = stringArg(call.arguments.name, "name");
    const path = call.name === READ_RESOURCE
      ? stringArg(call.arguments.path, "path")
      : undefined;
    return {
      id: call.id ?? fallbackId,
      name: call.name,
      title: call.name === ACTIVATE ? `加载 ${skillName} 的完整指令` : `读取 ${skillName}/${path}`,
      kind: "read",
      arguments: { name: skillName, ...(path ? { path } : {}) },
      permission: "allow",
      locations: [],
      dedupeKey: `skill:${call.name}:${canonicalJson(call.arguments)}`,
      retry: "none",
      ...(!this.allowedNames.has(skillName) ? { validationError: `当前 Agent 未绑定 Skill: ${skillName}` } : {}),
    };
  }

  /** 执行「execute」主流程，传播取消与失败并在结束时清理临时资源。 */
async execute(call: PreparedToolCall, _context: ToolExecutionContext): Promise<ToolResult> {
    const skillName = String(call.arguments.name);
    if (call.name === ACTIVATE) {
      const value = await this.registry.instructions(skillName, this.allowedNames);
      const rawOutput = {
        name: skillName,
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
    const value = await this.registry.readResource(skillName, String(call.arguments.path), this.allowedNames);
    const rawOutput = {
      name: skillName,
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

  /** 生成「capabilitySnapshot」不可变视图，隔离后续状态修改并只暴露该层需要的事实。 */
capabilitySnapshot(): RuntimeCapabilitySnapshot {
    return {
      tools: this.definitions.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(definition) => ({
        id: `skill-runtime:tool:${definition.function.name}`,
        modelName: definition.function.name,
        origin: "skill_runtime",
        schemaHash: toolSchemaHash(definition),
      })),
      mcpServers: [],
      skills: this.registry.selected([...this.allowedNames]).map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(skill) => ({
        name: skill.name,
        contentHash: skill.contentHash,
        source: skill.source.kind,
      })),
    };
  }
}

/** 执行「definitions」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function definitions(names: string[]): ModelToolDefinition[] { return [
  {
    type: "function",
    function: {
      name: ACTIVATE,
      description: "读取并加载当前 Agent 已绑定的一个 Skill 的完整 SKILL.md。安装或绑定只会让 Skill 出现在可用目录中，不等于已经加载；本工具也不执行原始任务。name 必须使用当前 JSON Schema enum 中的值，同一 Turn 已成功加载的 Skill 无需重复调用。",
      parameters: {
        type: "object",
        properties: { name: { type: "string", enum: names, description: "available_skills 中的 Skill name" } },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: READ_RESOURCE,
      description: "在 activate_skill 已加载完整 SKILL.md 后，读取其中明确引用的 references、assets 或 scripts 文本资源；不会执行脚本。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", enum: names, description: "已激活 Skill 的 name" },
          path: { type: "string", description: "相对 Skill 根目录的文件路径" },
        },
        required: ["name", "path"],
        additionalProperties: false,
      },
    },
  },
]; }

/** 执行「stringArg」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function stringArg(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} 必须是非空字符串`);
  return value;
}
