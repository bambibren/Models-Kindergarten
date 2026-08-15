import { describe, expect, it } from "vitest";
import { loadDemoSessionReasoning, saveDemoSessionReasoning } from "./demo-reasoning-state.js";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe("demo session reasoning", () => {
  it("persists an override per Session and removes it when following the Agent", () => {
    const storage = memoryStorage();
    saveDemoSessionReasoning(storage, "one", "deep");
    saveDemoSessionReasoning(storage, "two", "fast");
    expect(loadDemoSessionReasoning(storage, "one")).toBe("deep");
    expect(loadDemoSessionReasoning(storage, "two")).toBe("fast");
    saveDemoSessionReasoning(storage, "one", "auto");
    expect(loadDemoSessionReasoning(storage, "one")).toBe("auto");
  });

  it("ignores malformed values", () => {
    const storage = memoryStorage();
    storage.setItem("models-kindergarten.demo-session-reasoning.one", "xhigh");
    expect(loadDemoSessionReasoning(storage, "one")).toBe("auto");
  });
});
