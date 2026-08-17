import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { emptyEntries } from "../../chat/chat-types.js";
import { idlePromptTurn } from "../../prompt-turn/prompt-turn-types.js";
import { ChatViewport } from "./ChatViewport.js";

describe("ChatViewport empty state", () => {
  it("describes the current ModelStudent without hard-coding qwen", () => {
    const html = renderToStaticMarkup(<ChatViewport
      historyChatEntries={emptyEntries()}
      onTurnAction={() => undefined}
      promptTurn={idlePromptTurn}
      streamingChatEntries={emptyEntries()}
    />);

    expect(html).toContain("当前 ModelStudent 通过 ACP");
    expect(html).not.toContain("qwen3:8b");
  });
});
