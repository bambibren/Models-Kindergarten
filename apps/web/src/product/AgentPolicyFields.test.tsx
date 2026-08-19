import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { McpInstallationView, SkillInstallation } from "@kindergarten/contracts";
import { AgentPolicyFields, type AgentPolicyValue } from "./AgentPolicyFields.js";

const policy: AgentPolicyValue = {
  systemPrompt: "先理解任务。",
  builtinTools: [
    { toolId: "read_file", enabled: true, permission: "allow" },
    { toolId: "web_search", enabled: false, permission: "ask" },
  ],
  skillInstallationIds: ["skill-ready"],
  mcps: [],
  historyPolicy: { mode: "recent_turns", maxTurns: 6 },
  memoryPolicy: { mode: "off" },
};

const skill: SkillInstallation = {
  schemaVersion: 1,
  skillInstallationId: "skill-ready",
  ownerId: "local-admin",
  skillName: "frontend-design",
  displayName: "frontend-design",
  state: "ready",
  source: { kind: "approved_local", sourceId: "frontend-design" },
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z",
};

const mcp: McpInstallationView = {
  schemaVersion: 1,
  mcpInstallationId: "mcp-ready",
  ownerId: "local-admin",
  name: "Docs MCP",
  transport: "streamable_http",
  url: "https://example.com/mcp",
  authKind: "none",
  enabled: true,
  state: "connected",
  snapshot: {
    schemaVersion: 1,
    generation: 1,
    tools: [{ name: "search_docs", inputSchema: {}, inputSchemaHash: "hash" }],
    resources: [{ uri: "docs://index", name: "Docs" }],
    prompts: [],
    discoveredAt: "2026-08-18T00:00:00.000Z",
  },
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z",
};

describe("AgentPolicyFields", () => {
  it("复用真实 Tool、Skill 和 MCP 控件，并可隐藏 History/Memory", () => {
    const html = renderToStaticMarkup(<AgentPolicyFields
      builtinToolIds={["read_file", "web_search"]}
      mcps={[mcp]}
      onChange={() => undefined}
      showHistory={false}
      showMemory={false}
      skills={[skill]}
      value={policy}
    />);

    expect(html).toContain("web_search");
    expect(html).toContain("每次询问");
    expect(html).toContain("frontend-design");
    expect(html).toContain("Docs MCP");
    expect(html).not.toContain("聊天历史");
    expect(html).not.toContain("Memory");
  });

  it("在 Agent 编辑页显示 History 和只读 Memory 状态", () => {
    const html = renderToStaticMarkup(<AgentPolicyFields
      builtinToolIds={["read_file", "web_search"]}
      mcps={[]}
      onChange={() => undefined}
      skills={[skill]}
      value={policy}
    />);

    expect(html).toContain("聊天历史");
    expect(html).toContain("Memory 固定关闭");
  });
});
