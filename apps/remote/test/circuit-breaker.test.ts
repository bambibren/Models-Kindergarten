import { describe, expect, it } from "vitest";
import { DependencyCircuits } from "../src/resilience/circuit-breaker.js";

describe("DependencyCircuits", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("按最近使用顺序限制动态依赖数量", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const circuits = new DependencyCircuits(2);
    const first = circuits.get("origin:a");
    const second = circuits.get("origin:b");

    expect(circuits.get("origin:a")).toBe(first);
    circuits.get("origin:c");

    expect(circuits.get("origin:a")).toBe(first);
    expect(circuits.get("origin:b")).not.toBe(second);
  });

  it("拒绝无效容量", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    expect(/** 构造「toThrow」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => new DependencyCircuits(0)).toThrow("正整数");
  });
});
