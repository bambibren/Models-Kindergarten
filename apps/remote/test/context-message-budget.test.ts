import { describe, expect, it } from "vitest";
import {
  observeMessage,
  rebudgetContextMessages,
  replaceContextSegmentsInPlace,
  type ContextBuildResult,
  type ContextSegment,
} from "../src/conversation/context-assembler.js";
import type { ModelMessage } from "../src/model/model-provider.js";

describe("Provider message budget", () => {
  it("能力刷新原子替换旧目录且不移动当前用户和工具闭环", () => {
    const oldCatalog = catalog("old", "sandbox-notes");
    const newCatalog = catalog("new", "frontend-design");
    const messages: ModelMessage[] = [
      { role: "system", content: oldCatalog.content },
      { role: "user", content: "当前任务" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "ensure-1", name: "ensure_agent_skills", arguments: {} }],
      },
      { role: "tool", content: "installed", toolCallId: "ensure-1", toolName: "ensure_agent_skills" },
    ];
    const built: ContextBuildResult = {
      messages,
      observations: [
        observeMessage(messages[0]!, "skill_catalog", oldCatalog.sourceId),
        observeMessage(messages[1]!, "current_turn", "current-prompt"),
        observeMessage(messages[2]!, "current_turn", "round:0:assistant"),
        observeMessage(messages[3]!, "tool_result", "ensure-1"),
      ],
      segments: [oldCatalog],
      truncatedSourceIds: [],
    };

    replaceContextSegmentsInPlace(built, [newCatalog]);

    expect(built.messages.filter((item) => item.content.includes("sandbox-notes"))).toHaveLength(0);
    expect(built.messages.filter((item) => item.content.includes("frontend-design"))).toHaveLength(1);
    expect(built.messages.map((item) => item.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(built.messages[1]?.content).toBe("当前任务");
    expect(built.messages[3]?.toolCallId).toBe("ensure-1");
    expect(built.segments).toEqual([newCatalog]);
  });

  it("历史 assistant + 多个 tool results 要么完整保留，要么整组裁掉", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "old question" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "old-a", name: "read_file", arguments: { path: "a" } },
          { id: "old-b", name: "read_file", arguments: { path: "b" } },
        ],
      },
      { role: "tool", content: "A", toolCallId: "old-a", toolName: "read_file" },
      { role: "tool", content: "B", toolCallId: "old-b", toolName: "read_file" },
      { role: "user", content: "current" },
    ];
    const observations = messages.map((message, index) => observeMessage(
      message,
      index === messages.length - 1 ? "current_turn" : message.role === "tool" ? "tool_result" : "session_history",
      index === messages.length - 1 ? "current-prompt" : `old-${index}`,
    ));

    const tooSmall = rebudgetContextMessages(messages, observations, 3);
    expect(tooSmall.messages.map((item) => item.role)).toEqual(["user"]);
    expect(tooSmall.messages[0]?.content).toBe("current");

    const exact = rebudgetContextMessages(messages, observations, 4);
    expect(exact.messages.map((item) => item.role)).toEqual([
      "assistant", "tool", "tool", "user",
    ]);
    expect(exact.messages.filter((item) => item.role === "tool").map((item) => item.toolCallId))
      .toEqual(["old-a", "old-b"]);
  });

  it("当前用户后的多 Tool 组不可裁剪，旧历史为它让出容量", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "old-1" },
      { role: "assistant", content: "old-2" },
      { role: "user", content: "current" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "current-a", name: "read_file", arguments: { path: "a" } },
          { id: "current-b", name: "read_file", arguments: { path: "b" } },
        ],
      },
      { role: "tool", content: "A", toolCallId: "current-a", toolName: "read_file" },
      { role: "tool", content: "B", toolCallId: "current-b", toolName: "read_file" },
    ];
    const observations = messages.map((message, index) => observeMessage(
      message,
      index >= 2 ? index === 2 || index === 3 ? "current_turn" : "tool_result" : "session_history",
      index === 2 ? "current-prompt" : `source-${index}`,
    ));

    const result = rebudgetContextMessages(messages, observations, 4);
    expect(result.messages.map((item) => item.role)).toEqual([
      "user", "assistant", "tool", "tool",
    ]);
    expect(result.messages[0]?.content).toBe("current");
    expect(result.messages.slice(2).map((item) => item.toolCallId))
      .toEqual(["current-a", "current-b"]);
    expect(result.truncatedSourceIds).toEqual(["source-0", "source-1"]);
  });

  it("固定上下文与当前用户超过容量时明确失败，不静默删除必需内容", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "skill catalog" },
      { role: "user", content: "current" },
    ];
    const observations = [
      observeMessage(messages[0]!, "skill_catalog", "skills"),
      observeMessage(messages[1]!, "current_turn", "current-prompt"),
    ];
    expect(() => rebudgetContextMessages(messages, observations, 1))
      .toThrow("当前用户与必需上下文共 2 条");
  });
});

function catalog(hash: string, name: string): ContextSegment {
  const content = `<available_skills>\n[{"name":"${name}"}]\n</available_skills>`;
  return {
    id: "skill-catalog",
    kind: "skill_catalog",
    role: "system",
    authority: "data",
    trust: "trusted",
    sourceId: "agent-version:skills",
    content,
    contentHash: hash,
    estimatedTokens: 1,
    lifetime: "agent_version",
    summary: { title: "可用技能", detail: name, itemCount: 1 },
  };
}
