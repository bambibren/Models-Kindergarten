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
import {
  explicitGitHubSkillUrlCandidates,
} from "./github-skill-source.js";
import type { SkillInstallationService } from "./skill-installation-service.js";

const NAME = "ensure_agent_skills";

/** 只有消息本身含有效来源时才向模型暴露安装 Tool。 */
export class EnsureAgentSkillsToolProvider implements RuntimeToolProvider {
  readonly providerId = "skill-installation";
  readonly definitions: ModelToolDefinition[];
  private readonly providedUrls: string[];
  private readonly allowedModes: Array<"ensure" | "update">;

  constructor(
    private readonly service: SkillInstallationService,
    private readonly scope: TurnScope,
    private readonly currentUserMessage: string,
  ) {
    this.providedUrls = explicitGitHubSkillUrlCandidates(currentUserMessage).map((item) => item.providedUrl);
    this.allowedModes = explicitlyRequestsUpdate(currentUserMessage) ? ["ensure", "update"] : ["ensure"];
    this.definitions = this.providedUrls.length > 0 ? definitions(this.providedUrls, this.allowedModes) : [];
  }

  prepare(call: ModelToolCall, fallbackId: string): PreparedToolCall {
    if (call.name !== NAME) throw new Error(`未知 Skill 安装 Tool: ${call.name}`);
    const sourceUrls = validStringArray(call.arguments.source_urls);
    const mode = call.arguments.mode;
    const invalidSource = sourceUrls?.find((url) => !this.providedUrls.includes(url));
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
        const category = error.retryable ? "network" : "validation";
        const publicError = { code: error.code, category, message: error.message };
        throw new ToolExecutionError(error.code, category, error.message, error.retryable, { error: publicError }, { cause: error });
      }
      throw error;
    }
    const rawOutput = {
      jobId: job.jobId,
      state: job.state,
      items: job.items.map((item) => ({
        source: item.source,
        state: item.state,
        disposition: item.disposition,
        skillInstallationId: item.skillInstallationId,
      })),
    };
    const skillNames = [...new Set(await Promise.all(job.items.map(async (item) => {
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

  capabilitySnapshot(): RuntimeCapabilitySnapshot {
    return {
      tools: this.definitions.map((definition) => ({
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

function definitions(
  providedUrls: string[],
  allowedModes: Array<"ensure" | "update">,
): ModelToolDefinition[] {
  return [{
    type: "function",
    function: {
      name: NAME,
      description: "安装、复用并绑定当前用户消息中明确给出的 GitHub Skill 地址。成功后 Runtime 会在下一模型轮提供更新后的 Skill 目录和工具 Schema；本工具不读取完整 SKILL.md。source_urls 必须从候选值中原样复制，不得推断、补全、缩短或改写。.git 后缀合法；/tree/{ref}/{path} 也是合法的具体目录地址，两者语义不同。下载失败表示参数已经验证通过，不要修改 URL。",
      parameters: {
        type: "object",
        properties: {
          source_urls: {
            type: "array",
            minItems: 1,
            maxItems: providedUrls.length,
            uniqueItems: true,
            items: { type: "string", enum: providedUrls },
            description: "只复制候选中的完整地址；不要删除 .git，不要缩短 /tree/... 地址。",
          },
          mode: { type: "string", enum: allowedModes, description: "普通安装或复用使用 ensure；只有用户明确要求更新时才可使用 update。" },
        },
        required: ["source_urls", "mode"],
        additionalProperties: false,
      },
    },
  }];
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === "string" && item.length > 0)) {
    throw new Error(`${label} 必须是非空字符串数组`);
  }
  return [...new Set(value)];
}

function validStringArray(value: unknown): string[] | undefined {
  try { return stringArray(value, "source_urls"); }
  catch { return undefined; }
}

function explicitlyRequestsUpdate(message: string): boolean {
  const withoutUrls = message.replace(/https:\/\/github\.com\/[^\s<>()"']+/gi, " ");
  return /(?:更新|升级|最新版|update)/i.test(withoutUrls);
}
