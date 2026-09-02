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
      initializing
      onLoadOlder={/** 构造「onLoadOlder」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => undefined}
      onTurnAction={/** 构造「onTurnAction」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => undefined}
      promptTurn={idlePromptTurn}
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
      initializing={false}
      onLoadOlder={() => undefined}
      onTurnAction={() => undefined}
      promptTurn={idlePromptTurn}
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
      initializing={false}
      onLoadOlder={() => undefined}
      onTurnAction={() => undefined}
      promptTurn={idlePromptTurn}
      scorableTurnIds={new Set(["turn-1"])}
      sessionId="session-1"
      streamingChatEntries={emptyEntries()}
    />);

    expect(html).toContain("效果打分");
    expect(html).toContain("/evaluation/sessions/session-1/turns/turn-1");
  });
});
