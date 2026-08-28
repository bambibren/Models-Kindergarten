import { describe, expect, it } from "vitest";
import { createDefaultModules } from "../context-lab/context-lab-state.js";
import { loadSavedAgents, mergeAgentStrategies, saveAgent } from "./agent-storage.js";

/** 构造「memoryStorage」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: /** 构造「getItem」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(key: string) => values.get(key) ?? null,
    setItem: /** 构造「setItem」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(key: string, value: string) => { values.set(key, value); },
  };
}

describe("demo agent storage", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("round-trips and upserts saved agents", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const storage = memoryStorage();
    const first = { id: "agent-custom", name: "自定义 Agent", description: "第一版", modules: createDefaultModules(), updatedAt: "刚刚", state: "active" as const };
    saveAgent(storage, first);
    saveAgent(storage, { ...first, description: "第二版" });
    expect(loadSavedAgents(storage)).toHaveLength(1);
    expect(loadSavedAgents(storage)[0]?.description).toBe("第二版");
  });

  it("ignores malformed storage", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const storage = memoryStorage();
    storage.setItem("models-kindergarten.demo-agents", "not-json");
    expect(loadSavedAgents(storage)).toEqual([]);
  });

  it("lets a saved edit replace the matching built-in Agent", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const builtIn = { id: "agent-default", name: "默认 Agent", description: "内置", modules: createDefaultModules(), updatedAt: "今天", state: "active" as const };
    const saved = { ...builtIn, description: "已编辑", updatedAt: "刚刚" };
    const merged = mergeAgentStrategies([saved], [builtIn]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.description).toBe("已编辑");
  });

  it("drops the removed Agent reasoning field from persisted Demo records", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
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
