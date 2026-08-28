import { afterEach, describe, expect, it, vi } from "vitest";
import { WebAccess } from "../src/tools/web-access.js";

afterEach(/** 在每个测试后释放临时资源，保证后续场景从干净状态开始。 */
() => {
  vi.unstubAllGlobals();
});

describe("Exa Web Search", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("通过 Remote MCP JSON-RPC 搜索并解析 SSE 中文结果", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const fetchMock = vi.fn(/** 构造「fetchMock」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async (_input: URL | RequestInfo, _init?: RequestInit) => new Response(exaSse([
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

  it("兼容 Exa 的普通 JSON 响应并按 URL 去重", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
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
    vi.stubGlobal("fetch", vi.fn(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
async () => new Response(JSON.stringify(payload), {
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

  it("把 JSON-RPC 上游错误暴露为可重试工具错误", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    vi.stubGlobal("fetch", vi.fn(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
async () => new Response(
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

  it("拒绝把无法识别的成功响应伪装成搜索成功", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    vi.stubGlobal("fetch", vi.fn(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
async () => new Response("not-json", { status: 200 })));

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

/** 构造「exaSse」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function exaSse(items: Array<[title: string, url: string, highlights: string]>): string {
  const text = items.map(/** 构造「join」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
([title, url, highlights]) => [
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
