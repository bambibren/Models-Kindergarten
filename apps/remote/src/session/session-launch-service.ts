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

export class SessionLaunchService {
  private readonly store: AtomicJsonStore<SessionLaunchDraft>;

  constructor(file: string, private readonly agents: AgentService, private readonly models: ModelStudentCatalog) {
    this.store = new AtomicJsonStore({ file, schemaVersion: 1, validate: isDraft });
  }

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
    await this.store.update((items) => [...items.filter((item) => Date.parse(item.expiresAt) > Date.now()), draft]);
    return draft;
  }

  async get(id: string, ownerId = "local-admin"): Promise<SessionLaunchDraft> {
    const draft = (await this.store.read()).find((item) => item.launchId === id && item.ownerId === ownerId);
    if (!draft) throw new ApiProblemError(404, "NOT_FOUND", "会话启动草稿不存在", false);
    if (Date.parse(draft.expiresAt) <= Date.now()) throw new ApiProblemError(410, "NOT_FOUND", "会话启动草稿已过期", false);
    return draft;
  }
}

function isDraft(value: unknown): value is SessionLaunchDraft {
  return record(value) && value.schemaVersion === 1 && typeof value.launchId === "string" && typeof value.ownerId === "string" &&
    typeof value.modelStudentId === "string" && typeof value.agentId === "string" && typeof value.promptText === "string" &&
    (value.artifactMentions === undefined || isArtifactMentions(value.artifactMentions)) &&
    (value.reasoningProfileOverride === undefined || isConcreteReasoningProfile(value.reasoningProfileOverride)) &&
    typeof value.createdAt === "string" && typeof value.expiresAt === "string";
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isArtifactMentions(value: unknown): value is ArtifactMentionInput[] {
  return Array.isArray(value) && value.every((item) => record(item) && typeof item.artifactId === "string" && item.artifactId.length > 0);
}
function readArtifactMentions(value: unknown): ArtifactMentionInput[] {
  if (value === undefined) return [];
  if (!isArtifactMentions(value)) throw invalid("artifactMentions 格式无效");
  return value.map((item) => ({ artifactId: item.artifactId }));
}
function invalid(message: string): ApiProblemError { return new ApiProblemError(400, "VALIDATION_FAILED", message, false); }
