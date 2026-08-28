import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ContextPreviewResponseV2 } from "@kindergarten/contracts";
import { ContextPreviewPanel } from "./ContextPreviewPanel.js";

const value: ContextPreviewResponseV2 = {
  schemaVersion: 2,
  runnable: true,
  diagnostics: [],
  agentSnapshotHash: "agent-hash",
  capabilityHash: "capability-hash",
  contextSummary: {
    schemaVersion: 1,
    turnId: "context-preview",
    totalEstimatedTokens: 99,
    items: [
      { id: "system", kind: "system_instruction", title: "Agent 基础指令", estimatedTokens: 20, raw: { provider: "openai", model: "demo", format: "json", value: "固定响应协议与 Skill 使用协议" } },
      { id: "tools", kind: "available_tools", title: "可用工具", itemCount: 2, estimatedTokens: 30, raw: { provider: "openai", model: "demo", format: "json", value: "read_file tool schema" } },
      { id: "skills", kind: "skill_catalog", title: "Skill 目录", itemCount: 1, estimatedTokens: 10, raw: { provider: "openai", model: "demo", format: "json", value: "frontend-design" } },
      { id: "mcp", kind: "mcp_resource_catalog", title: "MCP Resource 目录", itemCount: 1, estimatedTokens: 10, raw: { provider: "openai", model: "demo", format: "json", value: "docs://index" } },
      { id: "history", kind: "session_history", title: "对话历史", itemCount: 4, estimatedTokens: 29, raw: { provider: "openai", model: "demo", format: "json", value: "不得展示的历史原文" } },
    ],
  },
  providerInput: { provider: "openai", model: "demo", format: "json", value: "公共用户提示与工具 schema" },
  providerInputHash: "input-hash",
  providerInputBytes: 99,
  effectiveConfigurationHash: "effective-hash",
  resolvedReasoning: { schemaVersion: 1, requestedProfile: "auto", resolvedProfile: "deep", source: "model_default", providerKind: "openai", model: "demo", native: { reasoning_effort: "high" } },
  model: { modelStudentId: "student", displayName: "Demo", providerKind: "openai", model: "demo" },
  history: { configuredPolicy: { mode: "recent_turns", maxTurns: 6 }, actualHistoryTurns: 0 },
};

describe("ContextPreviewPanel", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("只读展示完整非历史上下文、推理、历史数量说明与 Provider 输入", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const html = renderToStaticMarkup(<ContextPreviewPanel value={value} onRefresh={/** 构造「onRefresh」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => undefined} />);

    expect(html).toContain("最终系统指令");
    expect(html).toContain("固定响应协议与 Skill 使用协议");
    expect(html).toContain("read_file tool schema");
    expect(html).toContain("frontend-design");
    expect(html).toContain("docs://index");
    expect(html).toContain("Provider 首轮序列化输入");
    expect(html).not.toContain("不得展示的历史原文");
    expect(html).toContain("公共用户提示与工具 schema");
    expect(html).not.toContain("对话历史");
    expect(html).toContain("最近 6 个完整 Turn");
    expect(html).toContain("实际进入历史为 0");
    expect(html).toContain("auto → deep");
  });
});
