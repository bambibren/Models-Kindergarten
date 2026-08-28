import { randomUUID } from "node:crypto";
import type { AgentService } from "../agent/agent-service.js";
import type { ModelStudentCatalog } from "../model/model-student-catalog.js";
import { ApiProblemError } from "../server/api-problem.js";
import { AtomicJsonStore } from "../storage/atomic-json-store.js";
import {
  isConcreteReasoningProfile,
  PRODUCT_CONFIG,
  type ArtifactMentionInput,
  type ConcreteReasoningProfile,
} from "@kindergarten/contracts";

/** 描述「SessionLaunchDraft」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export interface SessionLaunchDraft {
  schemaVersion: 1;
  launchId: string;
  ownerId: string;
  modelStudentId: string;
  agentId: string;
  promptText: string;
  artifactMentions?: ArtifactMentionInput[];
  reasoningProfileOverride?: ConcreteReasoningProfile;
  createdAt: string;
  expiresAt: string;
}

/** 描述「SessionLaunchService」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */
export class SessionLaunchService {
  private readonly store: AtomicJsonStore<SessionLaunchDraft>;

  /** 初始化「SessionLaunchService」所需依赖，不在构造阶段启动不可回收的后台任务。 */
constructor(file: string, private readonly agents: AgentService, private readonly models: ModelStudentCatalog) {
    this.store = new AtomicJsonStore({ file, schemaVersion: 1, validate: isDraft });
  }

  /** 根据已校验输入构建「create」结果，不额外持有调用方的大对象。 */
async create(raw: unknown, ownerId = "local-admin"): Promise<SessionLaunchDraft> {
    if (!record(raw) || typeof raw.modelStudentId !== "string" || typeof raw.agentId !== "string" || typeof raw.promptText !== "string") throw invalid("会话启动草稿格式无效");
    if (raw.reasoningProfileOverride !== undefined && !isConcreteReasoningProfile(raw.reasoningProfileOverride)) {
      throw invalid("reasoningProfileOverride 格式无效");
    }
    const artifactMentions = readArtifactMentions(raw.artifactMentions);
    const promptText = raw.promptText.trim();
    if (!promptText || promptText.length > PRODUCT_CONFIG.sessionLaunch.maxPromptCharacters) {
      throw invalid(`promptText 必须为 1 到 ${PRODUCT_CONFIG.sessionLaunch.maxPromptCharacters} 个字符`);
    }
    if (!this.models.isReady(raw.modelStudentId)) throw new ApiProblemError(409, "SESSION_BINDING_INVALID", "ModelStudent 不可用", false);
    await this.agents.get(raw.agentId, ownerId);
    const created = new Date();
    const draft: SessionLaunchDraft = {
      schemaVersion: 1,
      launchId: randomUUID(),
      ownerId,
      modelStudentId: raw.modelStudentId,
      agentId: raw.agentId,
      promptText,
      ...(artifactMentions.length > 0 ? { artifactMentions } : {}),
      ...(isConcreteReasoningProfile(raw.reasoningProfileOverride)
        ? { reasoningProfileOverride: raw.reasoningProfileOverride }
        : {}),
      createdAt: created.toISOString(),
      expiresAt: new Date(created.getTime() + PRODUCT_CONFIG.sessionLaunch.draftTtlMs).toISOString(),
    };
    await this.store.update(/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
(items) => [...items.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => Date.parse(item.expiresAt) > Date.now()), draft]);
    return draft;
  }

  /** 读取「get」所需数据，并遵守作用域、分页与容量边界。 */
async get(id: string, ownerId = "local-admin"): Promise<SessionLaunchDraft> {
    const now = Date.now();
    const draft = await this.store.update(/** 执行「draft」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(items) => {
      const found = items.find(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => item.launchId === id && item.ownerId === ownerId);
      return {
        records: items.filter(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => Date.parse(item.expiresAt) > now),
        result: found ? structuredClone(found) : undefined,
      };
    });
    if (!draft) throw new ApiProblemError(404, "NOT_FOUND", "会话启动草稿不存在", false);
    if (Date.parse(draft.expiresAt) <= now) throw new ApiProblemError(410, "NOT_FOUND", "会话启动草稿已过期", false);
    return draft;
  }
}

/** 判断「isDraft」对应条件，只返回判定结果且不修改输入状态。 */
function isDraft(value: unknown): value is SessionLaunchDraft {
  return record(value) && value.schemaVersion === 1 && typeof value.launchId === "string" && typeof value.ownerId === "string" &&
    typeof value.modelStudentId === "string" && typeof value.agentId === "string" && typeof value.promptText === "string" &&
    (value.artifactMentions === undefined || isArtifactMentions(value.artifactMentions)) &&
    (value.reasoningProfileOverride === undefined || isConcreteReasoningProfile(value.reasoningProfileOverride)) &&
    typeof value.createdAt === "string" && typeof value.expiresAt === "string";
}
/** 更新「record」对应状态，并保持写入顺序、原子性与容量约束。 */
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
/** 判断「isArtifactMentions」对应条件，只返回判定结果且不修改输入状态。 */
function isArtifactMentions(value: unknown): value is ArtifactMentionInput[] {
  return Array.isArray(value) && value.every(/** 按当前业务条件筛选或判断元素，不修改原始集合。 */
(item) => record(item) && typeof item.artifactId === "string" && item.artifactId.length > 0);
}
/** 读取「readArtifactMentions」所需数据，并遵守作用域、分页与容量边界。 */
function readArtifactMentions(value: unknown): ArtifactMentionInput[] {
  if (value === undefined) return [];
  if (!isArtifactMentions(value)) throw invalid("artifactMentions 格式无效");
  return value.map(/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */
(item) => ({ artifactId: item.artifactId }));
}
/** 执行「invalid」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function invalid(message: string): ApiProblemError { return new ApiProblemError(400, "VALIDATION_FAILED", message, false); }
