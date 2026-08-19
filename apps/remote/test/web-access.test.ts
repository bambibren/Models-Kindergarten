import { afterEach, describe, expect, it, vi } from "vitest";
import { WebAccess } from "../src/tools/web-access.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Exa Web Search", () => {
  it("通过 Remote MCP JSON-RPC 搜索并解析 SSE 中文结果", async () => {
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, _init?: RequestInit) => new Response(exaSse([
      [
        "旺仔QQ糖（软质糖果）",
        "https://baike.baidu.com/item/qq",
        "有不同的风味：[草莓味](https://example.com/strawberry)、荔枝味和葡萄味。",
      ],
      ["旺仔官网", "https://www.want-want.com/", "旺旺集团产品资料。"],
    ]), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const results = await new WebAccess("https://8.8.8.8/mcp").search(
      "旺仔QQ糖 全口味",
      5,
      new AbortController().signal,
    );

    expect(results).toEqual([
      {
        title: "旺仔QQ糖（软质糖果）",
        url: "https://baike.baidu.com/item/qq",
        snippet: "有不同的风味：草莓味、荔枝味和葡萄味。",
      },
      {
        title: "旺仔官网",
        url: "https://www.want-want.com/",
        snippet: "旺旺集团产品资料。",
      },
    ]);

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init).toMatchObject({
      method: "POST",
      redirect: "manual",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "web_search_exa",
        arguments: {
          query: "旺仔QQ糖 全口味",
          type: "fast",
          numResults: 5,
          livecrawl: "fallback",
          contextMaxCharacters: 3_000,
        },
      },
    });
  });

  it("兼容 Exa 的普通 JSON 响应并按 URL 去重", async () => {
    const payload = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{
          type: "text",
          text: [
            "Title: A\nURL: https://example.com/a\nHighlights:\nfirst",
            "Title: A duplicate\nURL: https://example.com/a\nHighlights:\nsecond",
          ].join("\n---\n"),
        }],
      },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));

    await expect(new WebAccess("https://8.8.8.8/mcp").search(
      "duplicate query",
      5,
      new AbortController().signal,
    )).resolves.toEqual([{
      title: "A",
      url: "https://example.com/a",
      snippet: "first",
    }]);
  });

  it("把 JSON-RPC 上游错误暴露为可重试工具错误", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      `event: message\ndata: ${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32000, message: "free rate limit exceeded" },
      })}\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )));

    await expect(new WebAccess("https://8.8.8.8/mcp").search(
      "rate limit",
      5,
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: "web_search_upstream_error",
      category: "network",
      retryable: true,
      message: "Exa 搜索服务失败: free rate limit exceeded",
    });
  });

  it("拒绝把无法识别的成功响应伪装成搜索成功", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not-json", { status: 200 })));

    await expect(new WebAccess("https://8.8.8.8/mcp").search(
      "broken response",
      5,
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: "web_search_invalid_response",
      category: "execution",
      retryable: true,
    });
  });
});

function exaSse(items: Array<[title: string, url: string, highlights: string]>): string {
  const text = items.map(([title, url, highlights]) => [
    `Title: ${title}`,
    `URL: ${url}`,
    "Published: N/A",
    "Highlights:",
    highlights,
  ].join("\n")).join("\n---\n");
  return `event: message\ndata: ${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text }] },
  })}\n`;
}
