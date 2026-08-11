import { describe, expect, it } from "vitest";
import { createDefaultModules } from "../context-lab/context-lab-state.js";
import type { DemoAgentStrategy, DemoMcpInstallation, DemoStreamItem } from "../demo-types.js";
import { boundMcpIds, loadRemovedMcpIds, loadSavedMcps, mergeMcpInstallations, projectStreamForAgent, removeMcp, saveMcp } from "./mcp-demo-state.js";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

const deepWiki: DemoMcpInstallation = {
  id: "mcp-deepwiki",
  name: "DeepWiki",
  description: "公开仓库文档",
  url: "https://mcp.deepwiki.com/mcp",
  transport: "streamable_http",
  authKind: "none",
  state: "ready",
  capabilities: [{ name: "ask_question", kind: "tool", description: "问答" }],
  boundAgentIds: ["agent-default"],
  lastCheckedAt: "刚刚",
};

function agentWithMcps(ids: string[]): DemoAgentStrategy {
  return {
    id: "agent-default",
    name: "默认 Agent",
    description: "测试",
    modules: createDefaultModules().map((module) => module.id === "mcp" ? { ...module, selectedItems: ids } : module),
    updatedAt: "刚刚",
    state: "active",
  };
}

describe("remote MCP demo state", () => {
  it("round-trips and merges account-level installations", () => {
    const storage = memoryStorage();
    saveMcp(storage, { ...deepWiki, name: "话本地图" });
    expect(loadSavedMcps(storage)[0]?.name).toBe("话本地图");
    expect(mergeMcpInstallations(loadSavedMcps(storage), [deepWiki])).toHaveLength(1);
  });

  it("reads MCP allowlist from the Agent module", () => {
    expect(boundMcpIds(agentWithMcps(["mcp-deepwiki"]))).toEqual(["mcp-deepwiki"]);
  });

  it("keeps an uninstalled fixture out of the merged account list", () => {
    const storage = memoryStorage();
    removeMcp(storage, deepWiki.id);
    expect(loadRemovedMcpIds(storage)).toEqual([deepWiki.id]);
    expect(mergeMcpInstallations(loadSavedMcps(storage), [deepWiki], loadRemovedMcpIds(storage))).toEqual([]);
  });

  it("projects only MCP calls exposed by the selected Agent", () => {
    const items: DemoStreamItem[] = [
      { id: "allowed", type: "tool", name: "ask_question", status: "completed", input: "{}", output: "ok", tokens: 1, requiredMcpId: "mcp-deepwiki" },
      { id: "blocked", type: "tool", name: "other", status: "completed", input: "{}", output: "no", tokens: 1, requiredMcpId: "mcp-other" },
    ];
    const projected = projectStreamForAgent(items, agentWithMcps(["mcp-deepwiki"]), [deepWiki]);
    expect(projected.map((item) => item.id)).toEqual(["allowed"]);
  });
});
