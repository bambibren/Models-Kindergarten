import { describe, expect, it } from "vitest";
import {
  addVersion,
  canRunExperiment,
  createFreshVersions,
  createHistoryVersions,
  moduleTokenLabel,
  removeVersion,
  replaceVersionModules,
  updateModule,
  updateSelectedItems,
  versionTokenLabel,
} from "./context-lab-state.js";

describe("context lab state", () => {
  it("requires two different strategies before a fresh experiment can run", () => {
    const versions = createFreshVersions();
    expect(canRunExperiment("fresh_prompt", "解释这个页面", versions)).toBe(false);
    const changed = updateModule(versions, "b", "memory", (module) => ({ ...module, enabled: true }));
    expect(canRunExperiment("fresh_prompt", "解释这个页面", changed)).toBe(true);
  });

  it("keeps historical snapshot immutable and reuses it", () => {
    const versions = createHistoryVersions();
    const changed = updateModule(versions, "a", "history", (module) => ({ ...module, historyTurns: 2 }));
    expect(changed).toBe(versions);
    expect(versions[0]?.runPolicy).toBe("reuse_snapshot");
  });

  it("allows two or three versions and never removes a locked version", () => {
    const history = createHistoryVersions();
    const withThird = addVersion(history);
    expect(withThird).toHaveLength(3);
    expect(addVersion(withThird)).toBe(withThird);
    expect(removeVersion(withThird, "a")).toBe(withThird);
    expect(removeVersion(withThird, "c")).toHaveLength(2);
  });

  it("does not invent token usage for a standalone history policy", () => {
    const fresh = createFreshVersions();
    const history = fresh[0]?.modules.find((module) => module.id === "history");
    expect(history?.tokens).toBeNull();
    expect(history && moduleTokenLabel(history)).toBe("运行时计算");
    expect(fresh[0] && versionTokenLabel(fresh[0])).toContain("动态项");

    const snapshot = createHistoryVersions()[0]?.modules.find((module) => module.id === "history");
    expect(snapshot?.tokens).toBe(162);
  });

  it("recalculates selectable module tokens when Skills or MCP selections change", () => {
    const version = createFreshVersions()[0];
    const skills = version?.modules.find((module) => module.id === "skills");
    const mcp = version?.modules.find((module) => module.id === "mcp");
    expect(skills?.tokens).toBe(126);
    expect(mcp?.tokens).toBe(292);
    expect(skills && updateSelectedItems(skills, ["sandbox-notes"]).tokens).toBe(64);
    expect(mcp && updateSelectedItems(mcp, []).tokens).toBe(0);
    expect(mcp && updateSelectedItems(mcp, ["mcp-huaben-map"]).tokens).toBe(164);
    expect(mcp && moduleTokenLabel(updateSelectedItems(mcp, []))).toBe("未选择");
    if (!version || !skills) return;
    const changed = {
      ...version,
      modules: version.modules.map((module) => module.id === "skills" ? updateSelectedItems(module, ["web-static"]) : module),
    };
    expect(versionTokenLabel(version)).toBe("静态约 1022 tokens + 动态项");
    expect(versionTokenLabel(changed)).toBe("静态约 958 tokens + 动态项");
  });

  it("imports a cloned Agent strategy only into an editable version", () => {
    const fresh = createFreshVersions();
    const imported = fresh[0]?.modules.map((module) => ({ ...module, enabled: module.id === "memory" }));
    expect(imported).toBeDefined();
    const changed = replaceVersionModules(fresh, "b", imported ?? []);
    expect(changed[1]?.modules.find((module) => module.id === "memory")?.enabled).toBe(true);
    expect(changed[1]?.modules).not.toBe(imported);

    const locked = createHistoryVersions();
    expect(replaceVersionModules(locked, "a", imported ?? [])).toBe(locked);
  });
});
