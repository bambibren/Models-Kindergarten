import type { AgentRecord } from "@kindergarten/contracts";
import { AtomicJsonStore } from "../storage/atomic-json-store.js";

export class AgentRepository {
  private readonly store: AtomicJsonStore<AgentRecord>;

  constructor(file: string) {
    this.store = new AtomicJsonStore({ file, schemaVersion: 1, validate: isAgentRecord });
  }

  all(): Promise<AgentRecord[]> {
    return this.store.read();
  }

  async get(agentId: string): Promise<AgentRecord | undefined> {
    const record = (await this.store.read()).find((item) => item.agentId === agentId);
    return record;
  }

  async insert(record: AgentRecord): Promise<void> {
    await this.store.update((records) => {
      if (records.some((item) => item.agentId === record.agentId)) throw new Error(`Agent 已存在: ${record.agentId}`);
      return [...records, record];
    });
  }

  async replace(record: AgentRecord): Promise<void> {
    await this.store.update((records) => {
      const index = records.findIndex((item) => item.agentId === record.agentId);
      if (index < 0) throw new Error(`Agent 不存在: ${record.agentId}`);
      const next = [...records];
      next[index] = record;
      return next;
    });
  }

  async update(agentId: string, change: (record: AgentRecord) => AgentRecord): Promise<AgentRecord> {
    const result = await this.store.update((records) => {
      const index = records.findIndex((item) => item.agentId === agentId);
      if (index < 0) throw new Error(`Agent 不存在: ${agentId}`);
      const current = records[index];
      if (!current) throw new Error(`Agent 不存在: ${agentId}`);
      const record = change(structuredClone(current));
      const next = [...records];
      next[index] = record;
      return { records: next, result: record };
    });
    if (!result) throw new Error(`Agent 不存在: ${agentId}`);
    return result;
  }

  async remove(agentId: string): Promise<void> {
    await this.store.update((records) => records.filter((item) => item.agentId !== agentId));
  }
}

function isAgentRecord(value: unknown): value is AgentRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Partial<AgentRecord>;
  return item.schemaVersion === 1 && typeof item.agentId === "string" && typeof item.ownerId === "string" &&
    typeof item.name === "string" && typeof item.systemPrompt === "string" && Array.isArray(item.builtinTools) &&
    Array.isArray(item.skills) && Array.isArray(item.mcps) &&
    !("defaultReasoningProfile" in item) &&
    typeof item.createdAt === "string" && typeof item.updatedAt === "string";
}
