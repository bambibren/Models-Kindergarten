import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionSidebar } from "./SessionSidebar.js";

describe("SessionSidebar", () => {
  it("does not claim every session uses the built-in qwen model", () => {
    const html = renderToStaticMarkup(<SessionSidebar
      activeId={null}
      disabled={false}
      onCreate={() => undefined}
      onSelect={() => undefined}
      sessions={[]}
    />);

    expect(html).not.toContain("qwen3:8b");
    expect(html).not.toContain("Ollama · 本地运行");
  });
});
