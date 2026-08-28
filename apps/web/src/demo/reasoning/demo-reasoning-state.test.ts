import { describe, expect, it } from "vitest";
import { loadDemoSessionReasoning, saveDemoSessionReasoning } from "./demo-reasoning-state.js";

/** 构造「memoryStorage」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: /** 构造「getItem」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(key: string) => values.get(key) ?? null,
    setItem: /** 构造「setItem」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(key: string, value: string) => { values.set(key, value); },
    removeItem: /** 构造「removeItem」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(key: string) => { values.delete(key); },
  };
}

describe("demo session reasoning", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("persists an override per Session and removes it when following the Agent", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const storage = memoryStorage();
    saveDemoSessionReasoning(storage, "one", "deep");
    saveDemoSessionReasoning(storage, "two", "fast");
    expect(loadDemoSessionReasoning(storage, "one")).toBe("deep");
    expect(loadDemoSessionReasoning(storage, "two")).toBe("fast");
    saveDemoSessionReasoning(storage, "one", "auto");
    expect(loadDemoSessionReasoning(storage, "one")).toBe("auto");
  });

  it("ignores malformed values", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const storage = memoryStorage();
    storage.setItem("models-kindergarten.demo-session-reasoning.one", "xhigh");
    expect(loadDemoSessionReasoning(storage, "one")).toBe("auto");
  });
});
