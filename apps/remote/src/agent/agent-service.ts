import { randomUUID } from "node:crypto";
import {
  canonicalAgentInput,
  parseAgentInput,
  type AgentInput,
  type AgentRecord,
  type CursorPage,
} from "@kindergarten/contracts";
import { ApiProblemError } from "../server/api-problem.js";
import type { AgentRepository } from "./agent-repository.js";

export interface AgentCapabilitySource {
  builtinToolIds(): string[];
  readySkillInstallationIds(): string[];
  mcpCapabilities(): Array<{ installationId: string; tools: string[]; resources: string[] }>;
}

export class AgentService {
  private readonly protectedIds = new Set<string>();
  constructor(
    private readonly repository: AgentRepository,
    private readonly capabilities: AgentCapabilitySource,
  ) {}

  protect(agentId: string): void { this.protectedIds.add(agentId); }

  async create(raw: unknown, ownerId = "local-admin"): Promise<AgentRecord> {
    const input = this.validate(raw);
    const now = new Date().toISOString();
    const record: AgentRecord = {
      schemaVersion: 1,
      agentId: randomUUID(),
      ownerId,
      recordKind: "user",
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      systemPrompt: input.systemPrompt,
      builtinTools: input.builtinTools,
      skills: input.skillInstallationIds.map((skillInstallationId) => ({ skillInstallationId, enabled: true })),
      mcps: input.mcps,
      historyPolicy: input.historyPolicy,
      memoryPolicy: input.memoryPolicy,
      createdAt: now,
      updatedAt: now,
    };
    await this.repository.insert(record);
    return { ...structuredClone(record), deletable: true };
  }

  async get(agentId: string, ownerId = "local-admin"): Promise<AgentRecord> {
    const record = await this.repository.get(agentId);
    if (!record || record.ownerId !== ownerId) throw new ApiProblemError(404, "NOT_FOUND", "Agent 不存在", false);
    return { ...record, deletable: !this.protectedIds.has(record.agentId) };
  }

  async list(options: { query?: string; cursor?: string; limit?: number }, ownerId = "local-admin"): Promise<CursorPage<AgentRecord>> {
    const query = options.query?.trim().toLocaleLowerCase() ?? "";
    const limit = Math.max(1, Math.min(100, options.limit ?? 20));
    const offset = decodeCursor(options.cursor);
    const records = (await this.repository.all())
      .filter((item) => item.ownerId === ownerId)
      .filter((item) => item.recordKind !== "experiment_policy")
      .filter((item) => !query || `${item.name}\n${item.description ?? ""}`.toLocaleLowerCase().includes(query))
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.agentId.localeCompare(right.agentId));
    const items = records.slice(offset, offset + limit).map((item) => ({ ...item, deletable: !this.protectedIds.has(item.agentId) }));
    return {
      items,
      ...(offset + items.length < records.length ? { nextCursor: encodeCursor(offset + items.length) } : {}),
    };
  }

  async update(agentId: string, raw: unknown, ownerId = "local-admin"): Promise<AgentRecord> {
    const input = this.validate(raw);
    const current = await this.get(agentId, ownerId);
    const record: AgentRecord = {
      schemaVersion: 1,
      agentId,
      ownerId,
      recordKind: current.recordKind ?? "user",
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      systemPrompt: input.systemPrompt,
      builtinTools: input.builtinTools,
      skills: input.skillInstallationIds.map((skillInstallationId) => ({ skillInstallationId, enabled: true })),
      mcps: input.mcps,
      historyPolicy: input.historyPolicy,
      memoryPolicy: input.memoryPolicy,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };
    await this.repository.replace(record);
    return { ...structuredClone(record), deletable: !this.protectedIds.has(agentId) };
  }

  async delete(agentId: string, ownerId = "local-admin"): Promise<void> {
    if (this.protectedIds.has(agentId)) throw new ApiProblemError(409, "CONFLICT", "系统内置 Agent 不可删除", false);
    await this.get(agentId, ownerId);
    await this.repository.remove(agentId);
  }

  async createExperimentPolicy(
    experimentId: string,
    variant: import("@kindergarten/contracts").ExperimentVariant,
    ownerId = "local-admin",
  ): Promise<AgentRecord> {
    const input = this.validate({
      name: `experiment-${experimentId}-${variant.label}`,
      description: "对照实验运行策略；不会出现在 Agent 管理列表",
      ...variant.policy,
    });
    const now = new Date().toISOString();
    const record: AgentRecord = {
      schemaVersion: 1,
      agentId: randomUUID(),
      ownerId,
      recordKind: "experiment_policy",
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      systemPrompt: input.systemPrompt,
      builtinTools: input.builtinTools,
      skills: input.skillInstallationIds.map((skillInstallationId) => ({ skillInstallationId, enabled: true })),
      mcps: input.mcps,
      historyPolicy: input.historyPolicy,
      memoryPolicy: input.memoryPolicy,
      createdAt: now,
      updatedAt: now,
    };
    await this.repository.insert(record);
    return record;
  }

  async mergeReadySkills(agentId: string, installationIds: string[], ownerId = "local-admin"): Promise<AgentRecord> {
    const ready = new Set(this.capabilities.readySkillInstallationIds());
    for (const id of installationIds) {
      if (!ready.has(id)) throw invalid(`Skill Installation 不可用: ${id}`);
    }
    await this.get(agentId, ownerId);
    return this.repository.update(agentId, (record) => {
      const ids = new Set(record.skills.filter((item) => item.enabled).map((item) => item.skillInstallationId));
      installationIds.forEach((id) => ids.add(id));
      return {
        ...record,
        skills: [...ids].toSorted().map((skillInstallationId) => ({ skillInstallationId, enabled: true })),
        updatedAt: new Date().toISOString(),
      };
    });
  }

  async removeMcpBindings(installationId: string, ownerId = "local-admin"): Promise<AgentRecord[]> {
    const affected = (await this.repository.all()).filter((record) =>
      record.ownerId === ownerId && record.mcps.some((item) => item.mcpInstallationId === installationId));
    const updated: AgentRecord[] = [];
    for (const agent of affected) {
      updated.push(await this.repository.update(agent.agentId, (record) => ({
        ...record,
        mcps: record.mcps.filter((item) => item.mcpInstallationId !== installationId),
        updatedAt: new Date().toISOString(),
      })));
    }
    return updated;
  }

  async removeSkillBindings(installationId: string, ownerId = "local-admin"): Promise<AgentRecord[]> {
    const affected = (await this.repository.all()).filter((record) =>
      record.ownerId === ownerId && record.skills.some((item) => item.skillInstallationId === installationId));
    const updated: AgentRecord[] = [];
    for (const agent of affected) {
      updated.push(await this.repository.update(agent.agentId, (record) => ({
        ...record,
        skills: record.skills.filter((item) => item.skillInstallationId !== installationId),
        updatedAt: new Date().toISOString(),
      })));
    }
    return updated;
  }

  capabilityOptions() {
    return {
      builtinTools: this.capabilities.builtinToolIds(),
      readySkillInstallationIds: this.capabilities.readySkillInstallationIds(),
      mcps: this.capabilities.mcpCapabilities(),
    };
  }

  validateContextPolicy(policy: import("@kindergarten/contracts").ExperimentContextPolicy): AgentInput {
    return this.validate({ name: "context-preview", description: "preview only", ...policy });
  }

  private validate(raw: unknown): AgentInput {
    let input: AgentInput;
    try { input = canonicalAgentInput(parseAgentInput(raw)); }
    catch (error) { throw new ApiProblemError(400, "VALIDATION_FAILED", errorText(error), false); }
    const tools = new Set(this.capabilities.builtinToolIds());
    for (const binding of input.builtinTools) if (!tools.has(binding.toolId)) throw invalid(`Built-in Tool 不存在: ${binding.toolId}`);
    const skills = new Set(this.capabilities.readySkillInstallationIds());
    for (const id of input.skillInstallationIds) if (!skills.has(id)) throw invalid(`Skill Installation 不可用: ${id}`);
    const mcps = new Map(this.capabilities.mcpCapabilities().map((item) => [item.installationId, item]));
    for (const binding of input.mcps) {
      const snapshot = mcps.get(binding.mcpInstallationId);
      if (!snapshot) throw invalid(`MCP Installation 不可用: ${binding.mcpInstallationId}`);
      for (const tool of binding.tools) if (!snapshot.tools.includes(tool.remoteName)) throw invalid(`MCP Tool 不存在: ${tool.remoteName}`);
      for (const resource of binding.resources) if (!snapshot.resources.includes(resource.uri)) throw invalid(`MCP Resource 不存在: ${resource.uri}`);
    }
    return input;
  }
}

function invalid(detail: string): ApiProblemError {
  return new ApiProblemError(400, "CAPABILITY_REFERENCE_INVALID", `CAPABILITY_REFERENCE_INVALID: ${detail}`, false);
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const value = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!Number.isInteger(value) || value < 0) throw new ApiProblemError(400, "VALIDATION_FAILED", "cursor 无效", false);
  return value;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
