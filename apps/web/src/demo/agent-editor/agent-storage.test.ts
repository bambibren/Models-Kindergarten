import { describe, expect, it } from "vitest";
import { createDefaultModules } from "../context-lab/context-lab-state.js";
import { loadSavedAgents, mergeAgentStrategies, saveAgent } from "./agent-storage.js";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

describe("demo agent storage", () => {
  it("round-trips and upserts saved agents", () => {
    const storage = memoryStorage();
    const first = { id: "agent-custom", name: "自定义 Agent", description: "第一版", modules: createDefaultModules(), updatedAt: "刚刚", state: "active" as const };
    saveAgent(storage, first);
    saveAgent(storage, { ...first, description: "第二版" });
    expect(loadSavedAgents(storage)).toHaveLength(1);
    expect(loadSavedAgents(storage)[0]?.description).toBe("第二版");
  });

  it("ignores malformed storage", () => {
    const storage = memoryStorage();
    storage.setItem("models-kindergarten.demo-agents", "not-json");
    expect(loadSavedAgents(storage)).toEqual([]);
  });

  it("lets a saved edit replace the matching built-in Agent", () => {
    const builtIn = { id: "agent-default", name: "默认 Agent", description: "内置", modules: createDefaultModules(), updatedAt: "今天", state: "active" as const };
    const saved = { ...builtIn, description: "已编辑", updatedAt: "刚刚" };
    const merged = mergeAgentStrategies([saved], [builtIn]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.description).toBe("已编辑");
  });

  it("drops the removed Agent reasoning field from persisted Demo records", () => {
    const storage = memoryStorage();
    storage.setItem("models-kindergarten.demo-agents", JSON.stringify([{
      id: "legacy", name: "旧 Agent", description: "旧数据", modules: createDefaultModules(), defaultReasoningProfile: "deep", updatedAt: "昨天", state: "active",
    }]));
    const loaded = loadSavedAgents(storage)[0];
    expect(loaded).toBeDefined();
    expect(loaded).not.toHaveProperty("defaultReasoningProfile");
    if (loaded) saveAgent(storage, loaded);
    expect(storage.getItem("models-kindergarten.demo-agents")).not.toContain("defaultReasoningProfile");
  });
});
