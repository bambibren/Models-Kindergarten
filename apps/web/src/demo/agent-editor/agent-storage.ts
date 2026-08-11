import type { DemoAgentStrategy } from "../demo-types.js";

export const demoAgentStorageKey = "models-kindergarten.demo-agents";

export interface AgentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadSavedAgents(storage: AgentStorage): DemoAgentStrategy[] {
  const raw = storage.getItem(demoAgentStorageKey);
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter(isAgentStrategy);
  } catch {
    return [];
  }
}

export function saveAgent(storage: AgentStorage, agent: DemoAgentStrategy): DemoAgentStrategy[] {
  const current = loadSavedAgents(storage);
  const next = [agent, ...current.filter((candidate) => candidate.id !== agent.id)];
  storage.setItem(demoAgentStorageKey, JSON.stringify(next));
  return next;
}

export function mergeAgentStrategies(saved: DemoAgentStrategy[], builtIns: DemoAgentStrategy[]): DemoAgentStrategy[] {
  const savedIds = new Set(saved.map((agent) => agent.id));
  return [...saved, ...builtIns.filter((agent) => !savedIds.has(agent.id))];
}

function isAgentStrategy(value: unknown): value is DemoAgentStrategy {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DemoAgentStrategy>;
  return typeof candidate.id === "string"
    && typeof candidate.name === "string"
    && typeof candidate.description === "string"
    && Array.isArray(candidate.modules)
    && typeof candidate.updatedAt === "string"
    && (candidate.state === "active" || candidate.state === "draft");
}
