import type { EnsureAgentSkillsInput } from "@kindergarten/contracts";
import type { RuntimeCapabilitySnapshot } from "../capability/capability-types.js";
import { toolSchemaHash, type RuntimeToolProvider } from "../capability/runtime-capability-catalog.js";
import type { ModelToolCall, ModelToolDefinition } from "../model/model-provider.js";
import type { TurnScope } from "../runtime/turn-scope.js";
import { ApiProblemError } from "../server/api-problem.js";
import { ToolExecutionError } from "../tools/tool-error.js";
import {
  canonicalJson,
  modelEnvelope,
  type PreparedToolCall,
  type ToolExecutionContext,
  type ToolResult,
} from "../tools/tool-registry.js";
import type { SkillInstallationService } from "./skill-installation-service.js";

const NAME = "ensure_agent_skills";

/** 只有消息本身含有效来源时才向模型暴露安装 Tool。 */
export class EnsureAgentSkillsToolProvider implements RuntimeToolProvider {
  readonly providerId = "skill-installation";
  readonly definitions: ModelToolDefinition[];
  private readonly providedUrls: string[];
  private readonly allowedModes: Array<"ensure" | "update">;

  /** 初始化「EnsureAgentSkillsToolProvider」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(
    private readonly service: SkillInstallationService,
    private readonly scope: TurnScope,
    private readonly currentUserMessage: string,
  ) {
    this.providedUrls = service.explicitSourceUrlCandidates(currentUserMessage).map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => item.providedUrl);
    this.allowedModes = explicitlyRequestsUpdate(currentUserMessage) ? ["ensure", "update"] : ["ensure"];
    this.definitions = this.providedUrls.length > 0 ? definitions(this.providedUrls, this.allowedModes) : [];
  }

  /** 执行「prepare」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
prepare(call: ModelToolCall, fallbackId: string): PreparedToolCall {
    if (call.name !== NAME) throw new Error(`未知 Skill 安装 Tool: ${call.name}`);
    const sourceUrls = validStringArray(call.arguments.source_urls);
    const mode = call.arguments.mode;
    const invalidSource = sourceUrls?.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(url) => !this.providedUrls.includes(url));
    const sourceError = sourceUrls === undefined
      ? "source_urls 必须是非空字符串数组"
      : invalidSource ? `SKILL_SOURCE_NOT_USER_PROVIDED: ${invalidSource}` : undefined;
    const modeError = typeof mode !== "string" || !this.allowedModes.includes(mode as "ensure" | "update")
      ? `mode 必须是 ${this.allowedModes.join(" 或 ")}`
      : undefined;
    const validationMessage = sourceError ?? modeError;
    const safeSourceUrls = sourceUrls ?? [];
    const safeMode = this.allowedModes.includes(mode as "ensure" | "update")
      ? mode as "ensure" | "update"
      : this.allowedModes[0] ?? "ensure";
    const exactRetryArguments = {
      source_urls: this.providedUrls,
      mode: this.allowedModes[0] ?? "ensure",
    };
    return {
      id: call.id ?? fallbackId,
      name: NAME,
      title: `安装或复用 ${safeSourceUrls.length} 个 Skills`,
      kind: "other",
      arguments: { source_urls: safeSourceUrls, mode: safeMode },
      permission: "allow",
      locations: [],
      dedupeKey: `skill-install:${canonicalJson({ sourceUrls: safeSourceUrls, mode: safeMode })}`,
      retry: "none",
      ...(validationMessage ? {
        validationError: {
          message: validationMessage,
          argumentCorrection: {
            message: "上面的调用没有执行。下一次调用必须原样使用 exact_retry_arguments，不得增加、删除、重命名或修改任何字段。",
            exactRetryArguments,
          },
          instruction: `请重新调用一次。正确的完整参数是：${canonicalJson(exactRetryArguments)}`,
        },
      } : {}),
    };
  }

  /** 执行「execute」主流程，传播取消与失败并在结束时清理临时资源。 */
async execute(call: PreparedToolCall, _context: ToolExecutionContext): Promise<ToolResult> {
    const input: EnsureAgentSkillsInput = {
      sourceUrls: stringArray(call.arguments.source_urls, "source_urls"),
      mode: call.arguments.mode === "update" ? "update" : "ensure",
    };
    let job;
    try {
      job = await this.service.ensureForTurn(input, this.scope, this.currentUserMessage);
    } catch (error) {
      if (error instanceof ApiProblemError) {
        const category = error.code === "SKILL_SOURCE_URL_LIMIT_EXCEEDED"
          ? "resource_limit"
          : error.retryable ? "network" : "validation";
        const publicError = { code: error.code, category, message: error.message };
        throw new ToolExecutionError(error.code, category, error.message, error.retryable, { error: publicError }, { cause: error });
      }
      throw error;
    }
    const rawOutput = {
      jobId: job.jobId,
      state: job.state,
      items: job.items.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => ({
        source: item.source,
        state: item.state,
        disposition: item.disposition,
        skillInstallationId: item.skillInstallationId,
      })),
    };
    const skillNames = [...new Set(await Promise.all(job.items.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
async (item) => {
      if (!item.skillInstallationId) throw new Error("Skill 安装成功但缺少 Installation ID");
      return (await this.service.get(item.skillInstallationId, job.ownerId)).skillName;
    })))];
    const result = {
      ...rawOutput,
      installed_skill_names: skillNames,
      capabilities_changed: true,
    };
    return {
      modelContent: modelEnvelope(call, true, result),
      rawOutput: result,
      content: [{ type: "content", content: { type: "text", text: JSON.stringify(result, null, 2) } }],
      locations: [],
      effects: { capabilitiesChanged: true },
    };
  }

  /** 生成「capabilitySnapshot」不可变视图，隔离后续状态修改并只暴露该层需要的事实。 */
capabilitySnapshot(): RuntimeCapabilitySnapshot {
    return {
      tools: this.definitions.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(definition) => ({
        id: "skill-installation:tool:ensure_agent_skills",
        modelName: NAME,
        origin: "skill_runtime",
        schemaHash: toolSchemaHash(definition),
      })),
      mcpServers: [],
      skills: [],
    };
  }
}

/** 执行「definitions」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function definitions(
  providedUrls: string[],
  allowedModes: Array<"ensure" | "update">,
): ModelToolDefinition[] {
  return [{
    type: "function",
    function: {
      name: NAME,
      description: "安装、复用并绑定当前用户消息中明确给出的 Skill 来源地址，支持 GitHub Skill 与已配置的 MK 静态资源链接。成功后 Runtime 会在下一模型轮提供更新后的 Skill 目录和工具 Schema；本工具不读取完整 SKILL.md。source_urls 必须从候选值中原样复制，不得推断、补全、缩短、切换源站或改写。下载失败表示参数已经验证通过，不要修改 URL。",
      parameters: {
        type: "object",
        properties: {
          source_urls: {
            type: "array",
            minItems: 1,
            maxItems: providedUrls.length,
            uniqueItems: true,
            items: { type: "string", enum: providedUrls },
            description: "只复制候选中的完整地址；不要修改协议、主机、端口或路径。",
          },
          mode: { type: "string", enum: allowedModes, description: "普通安装或复用使用 ensure；只有用户明确要求更新时才可使用 update。" },
        },
        required: ["source_urls", "mode"],
        additionalProperties: false,
      },
    },
  }];
}

/** 执行「stringArray」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => typeof item === "string" && item.length > 0)) {
    throw new Error(`${label} 必须是非空字符串数组`);
  }
  return [...new Set(value)];
}

/** 执行「validStringArray」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function validStringArray(value: unknown): string[] | undefined {
  try { return stringArray(value, "source_urls"); }
  catch { return undefined; }
}

/** 执行「explicitlyRequestsUpdate」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function explicitlyRequestsUpdate(message: string): boolean {
  const withoutUrls = message.replace(/https?:\/\/[^\s<>()"']+/gi, " ");
  return /(?:更新|升级|最新版|update)/i.test(withoutUrls);
}
