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

describe("demo skill installation", () => {
  it("keeps the three public sources in the website development prompt", () => {
    expect(isWebsiteDevelopmentRequest(websiteDevelopmentPrompt)).toBe(true);
    for (const source of websiteSkillSources) expect(websiteDevelopmentPrompt).toContain(source);
  });

  it("advances a batch to ready without changing source order", () => {
    let batch = createDemoSkillInstallBatch(websiteSkillSources, [], "batch-test");
    for (let index = 0; index < 4; index += 1) batch = advanceDemoSkillInstallBatch(batch);
    expect(isDemoSkillInstallComplete(batch)).toBe(true);
    expect(batch.items.map((item) => item.name)).toEqual(["frontend-design", "design-brief", "impeccable-design-polish"]);
  });

  it("binds installed skills to the same Agent record", () => {
    const agent: DemoAgentStrategy = { id: "agent-one", name: "Agent", description: "test", modules: createDefaultModules(), updatedAt: "now", state: "active" };
    const updated = bindSkillsToAgent(agent, ["frontend-design", "design-brief"]);
    expect(updated.id).toBe(agent.id);
    expect(updated.modules.find((module) => module.id === "skills")?.selectedItems).toEqual(expect.arrayContaining(["frontend-design", "design-brief"]));
  });
});
