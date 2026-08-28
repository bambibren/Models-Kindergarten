import { describe, expect, it } from "vitest";
import { createDefaultModules } from "../context-lab/context-lab-state.js";
import type { DemoAgentStrategy, DemoMcpInstallation, DemoStreamItem } from "../demo-types.js";
import { boundMcpIds, loadRemovedMcpIds, loadSavedMcps, mergeMcpInstallations, projectStreamForAgent, removeMcp, saveMcp } from "./mcp-demo-state.js";

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

/** 构造「agentWithMcps」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function agentWithMcps(ids: string[]): DemoAgentStrategy {
  return {
    id: "agent-default",
    name: "默认 Agent",
    description: "测试",
    modules: createDefaultModules().map(/** 构造「modules」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(module) => module.id === "mcp" ? { ...module, selectedItems: ids } : module),
    updatedAt: "刚刚",
    state: "active",
  };
}

describe("remote MCP demo state", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("round-trips and merges account-level installations", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const storage = memoryStorage();
    saveMcp(storage, { ...deepWiki, name: "话本地图" });
    expect(loadSavedMcps(storage)[0]?.name).toBe("话本地图");
    expect(mergeMcpInstallations(loadSavedMcps(storage), [deepWiki])).toHaveLength(1);
  });

  it("reads MCP allowlist from the Agent module", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    expect(boundMcpIds(agentWithMcps(["mcp-deepwiki"]))).toEqual(["mcp-deepwiki"]);
  });

  it("keeps an uninstalled fixture out of the merged account list", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const storage = memoryStorage();
    removeMcp(storage, deepWiki.id);
    expect(loadRemovedMcpIds(storage)).toEqual([deepWiki.id]);
    expect(mergeMcpInstallations(loadSavedMcps(storage), [deepWiki], loadRemovedMcpIds(storage))).toEqual([]);
  });

  it("projects only MCP calls exposed by the selected Agent", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const items: DemoStreamItem[] = [
      { id: "allowed", type: "tool", name: "ask_question", status: "completed", input: "{}", output: "ok", tokens: 1, requiredMcpId: "mcp-deepwiki" },
      { id: "blocked", type: "tool", name: "other", status: "completed", input: "{}", output: "no", tokens: 1, requiredMcpId: "mcp-other" },
    ];
    const projected = projectStreamForAgent(items, agentWithMcps(["mcp-deepwiki"]), [deepWiki]);
    expect(projected.map(/** 构造「toEqual」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(item) => item.id)).toEqual(["allowed"]);
  });
});
