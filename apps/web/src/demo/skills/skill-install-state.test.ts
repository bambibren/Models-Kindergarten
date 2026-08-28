import { describe, expect, it } from "vitest";
import { createDefaultModules } from "../context-lab/context-lab-state.js";
import type { DemoAgentStrategy } from "../demo-types.js";
import {
  advanceDemoSkillInstallBatch,
  bindSkillsToAgent,
  createDemoSkillInstallBatch,
  isDemoSkillInstallComplete,
  isWebsiteDevelopmentRequest,
  websiteDevelopmentPrompt,
  websiteSkillSources,
} from "./skill-install-state.js";

describe("demo skill installation", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("keeps the three public sources in the website development prompt", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    expect(isWebsiteDevelopmentRequest(websiteDevelopmentPrompt)).toBe(true);
    for (const source of websiteSkillSources) expect(websiteDevelopmentPrompt).toContain(source);
  });

  it("advances a batch to ready without changing source order", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    let batch = createDemoSkillInstallBatch(websiteSkillSources, [], "batch-test");
    for (let index = 0; index < 4; index += 1) batch = advanceDemoSkillInstallBatch(batch);
    expect(isDemoSkillInstallComplete(batch)).toBe(true);
    expect(batch.items.map(/** 构造「toEqual」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(item) => item.name)).toEqual(["frontend-design", "design-brief", "impeccable-design-polish"]);
  });

  it("binds installed skills to the same Agent record", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const agent: DemoAgentStrategy = { id: "agent-one", name: "Agent", description: "test", modules: createDefaultModules(), updatedAt: "now", state: "active" };
    const updated = bindSkillsToAgent(agent, ["frontend-design", "design-brief"]);
    expect(updated.id).toBe(agent.id);
    expect(updated.modules.find(/** 构造「selectedItems」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(module) => module.id === "skills")?.selectedItems).toEqual(expect.arrayContaining(["frontend-design", "design-brief"]));
  });
});
