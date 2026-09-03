import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { emptyEntries } from "../../chat/chat-types.js";
import { idlePromptTurn } from "../../prompt-turn/prompt-turn-types.js";
import { ChatViewport } from "./ChatViewport.js";

describe("ChatViewport empty state", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("shows only the session initializer while the empty session is connecting", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const html = renderToStaticMarkup(<ChatViewport
      historyPaging={{ loading: false, hasMore: false }}
      historyChatEntries={emptyEntries()}
      contextExperimentCompatibilityPassed
      initializing
      onLoadOlder={/** 构造「onLoadOlder」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => undefined}
      onTurnAction={/** 构造「onTurnAction」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => undefined}
      promptTurn={idlePromptTurn}
      scoreCompatibilityPassed
      streamingChatEntries={emptyEntries()}
    />);

    expect(html).toContain('aria-label="正在初始化会话"');
    expect(html).not.toContain("今天想让模型学习什么？");
  });

  it("keeps a ready empty session blank instead of reusing the home welcome", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
() => {
    const html = renderToStaticMarkup(<ChatViewport
      historyPaging={{ loading: false, hasMore: false }}
      historyChatEntries={emptyEntries()}
      contextExperimentCompatibilityPassed
      initializing={false}
      onLoadOlder={() => undefined}
      onTurnAction={() => undefined}
      promptTurn={idlePromptTurn}
      scoreCompatibilityPassed
      streamingChatEntries={emptyEntries()}
    />);

    expect(html).toBe('<section class="session-empty-state"></section>');
    expect(html).not.toContain("今天想让模型学习什么？");
  });

  it("只为明确完成的历史 Turn 显示效果打分入口", () => {
    const entries = {
      order: ["message:user", "message:assistant"],
      byId: {
        "message:user": { type: "message" as const, id: "message:user", messageId: "user", turnId: "turn-1", role: "user" as const, content: [{ type: "text" as const, text: "问题" }], status: "done" as const },
        "message:assistant": { type: "message" as const, id: "message:assistant", messageId: "assistant", turnId: "turn-1", role: "assistant" as const, content: [{ type: "text" as const, text: "回答" }], status: "done" as const },
      },
    };
    const html = renderToStaticMarkup(<ChatViewport
      historyPaging={{ loading: false, hasMore: false }}
      historyChatEntries={entries}
      contextExperimentCompatibilityPassed
      initializing={false}
      onLoadOlder={() => undefined}
      onTurnAction={() => undefined}
      promptTurn={idlePromptTurn}
      scoreCompatibilityPassed
      completedTurnIds={new Set(["turn-1"])}
      sessionId="session-1"
      streamingChatEntries={emptyEntries()}
    />);

    expect(html).toContain("本次对话效果打分");
    expect(html).toContain("/evaluation/sessions/session-1/turns/turn-1");
  });

  it("在效果打分右侧独立显示上下文实验按钮", () => {
    const entries = {
      order: ["context:turn-1", "message:assistant", "tool:failed"],
      byId: {
        "context:turn-1": {
          type: "context_summary" as const,
          id: "context:turn-1",
          turnId: "turn-1",
          summary: {
            schemaVersion: 1 as const,
            turnId: "turn-1",
            items: [{ id: "system", kind: "system_instruction" as const, title: "系统指令", estimatedTokens: 12 }],
            totalEstimatedTokens: 12,
          },
        },
        "message:assistant": { type: "message" as const, id: "message:assistant", messageId: "assistant", turnId: "turn-1", role: "assistant" as const, content: [{ type: "text" as const, text: "回答" }], status: "done" as const },
        "tool:failed": {
          type: "tool_call" as const,
          id: "tool:failed",
          toolCallId: "failed",
          turnId: "turn-1",
          title: "复用 Artifact 失败",
          name: "reuse_artifact",
          kind: "other" as const,
          status: "failed" as const,
          content: [],
          locations: [],
        },
      },
    };
    const render = (
      experimentsEnabled: boolean,
      completedTurnIds: ReadonlySet<string>,
      scoreCompatibilityPassed = true,
      contextExperimentCompatibilityPassed = true,
    ) => renderToStaticMarkup(<ChatViewport
      contextExperimentCompatibilityPassed={contextExperimentCompatibilityPassed}
      experimentsEnabled={experimentsEnabled}
      historyPaging={{ loading: false, hasMore: false }}
      historyChatEntries={entries}
      initializing={false}
      onLoadOlder={() => undefined}
      onTurnAction={() => undefined}
      promptTurn={idlePromptTurn}
      scoreCompatibilityPassed={scoreCompatibilityPassed}
      completedTurnIds={completedTurnIds}
      sessionId="session-1"
      streamingChatEntries={emptyEntries()}
    />);

    const both = render(true, new Set(["turn-1"]));
    const experimentOnly = render(true, new Set(["turn-1"]), false, true);
    const scoreOnly = render(false, new Set(["turn-1"]));
    const failed = render(true, new Set());
    const historical = render(true, new Set(["turn-1"]), false, false);
    const scoreCompatibilityOnly = render(true, new Set(["turn-1"]), true, false);
    const experimentCompatibilityOnly = render(true, new Set(["turn-1"]), false, true);
    expect(both.indexOf("本次对话效果打分")).toBeLessThan(both.indexOf("ABTest评测"));
    expect(both.indexOf("复用 Artifact 失败")).toBeLessThan(both.indexOf("本次对话效果打分"));
    expect(both).toContain('<button class="turn-context-experiment" type="button">');
    expect(experimentOnly).toContain("ABTest评测");
    expect(experimentOnly).not.toContain("本次对话效果打分");
    expect(scoreOnly).toContain("本次对话效果打分");
    expect(scoreOnly).not.toContain("ABTest评测");
    expect(failed).not.toContain("本次对话效果打分");
    expect(failed).not.toContain("ABTest评测");
    expect(historical).not.toContain("本次对话效果打分");
    expect(historical).not.toContain("ABTest评测");
    expect(scoreCompatibilityOnly).toContain("本次对话效果打分");
    expect(scoreCompatibilityOnly).not.toContain("ABTest评测");
    expect(experimentCompatibilityOnly).not.toContain("本次对话效果打分");
    expect(experimentCompatibilityOnly).toContain("ABTest评测");
  });

  it("把回答中的内部 Artifact 标识投影为当前站点的 HTTP 路由", () => {
    const entries = {
      order: ["message:assistant"],
      byId: {
        "message:assistant": {
          type: "message" as const,
          id: "message:assistant",
          messageId: "assistant",
          turnId: "turn-1",
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "[打开产物](artifact://artifact_12345678)" }],
          status: "done" as const,
        },
      },
    };
    const html = renderToStaticMarkup(<ChatViewport
      historyPaging={{ loading: false, hasMore: false }}
      historyChatEntries={entries}
      contextExperimentCompatibilityPassed
      initializing={false}
      onLoadOlder={() => undefined}
      onTurnAction={() => undefined}
      promptTurn={idlePromptTurn}
      scoreCompatibilityPassed
      streamingChatEntries={emptyEntries()}
    />);

    expect(html).toContain('href="/artifacts/artifact_12345678"');
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain('type="button"');
  });
});
