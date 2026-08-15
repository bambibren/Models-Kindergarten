import type { ReasoningProfile } from "@kindergarten/contracts";

export const demoSessionReasoningPrefix = "models-kindergarten.demo-session-reasoning.";

export interface DemoReasoningStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function loadDemoSessionReasoning(storage: Pick<DemoReasoningStorage, "getItem">, sessionId: string): ReasoningProfile {
  const value = storage.getItem(key(sessionId));
  return value === "fast" || value === "balanced" || value === "deep" || value === "max" ? value : "auto";
}

export function saveDemoSessionReasoning(storage: DemoReasoningStorage, sessionId: string, profile: ReasoningProfile): void {
  if (profile === "auto") storage.removeItem(key(sessionId));
  else storage.setItem(key(sessionId), profile);
}

function key(sessionId: string): string {
  return `${demoSessionReasoningPrefix}${sessionId}`;
}
