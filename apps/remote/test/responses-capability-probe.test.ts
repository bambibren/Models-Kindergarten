import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResponsesModelCandidateInput } from "@kindergarten/contracts";
import { ResponsesCapabilityProber } from "../src/model/responses-capability-probe.js";
import {
  startResponsesCapabilityMockServer,
  type ResponsesCapabilityMockServer,
} from "./support/responses-capability-mock-server.js";

const servers: ResponsesCapabilityMockServer[] = [];

afterEach(/** 在每个测试后释放临时资源，保证后续场景从干净状态开始。 */
async () => {
  await Promise.all(servers.splice(0).map(/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */
(server) => server.close()));
});

describe("Responses 自定义端点能力体检", /** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */
() => {
  it("相同 modelId 在两个端点得到各自实测的 effort 集合，不按模型名称套 preset", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const full = await start({ supportedEfforts: ["low", "medium", "high", "xhigh"] });
    const partial = await start({ supportedEfforts: ["low", "high"] });
    const guarded: string[] = [];
    const prober = new ResponsesCapabilityProber({
      timeoutMs: 2_000,
      maxOutputTokens: 32,
      endpointGuard: /** 构造「endpointGuard」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(url) => { guarded.push(url.toString()); },
      now: /** 构造「now」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => new Date("2026-08-14T00:00:00.000Z"),
    });

    const fullSnapshot = await prober.probe(candidate(full.baseUrl, "gpt-5.5"));
    const partialSnapshot = await prober.probe(candidate(partial.baseUrl, "gpt-5.5"));

    expect(fullSnapshot).toMatchObject({
      streaming: true,
      text: true,
      toolCalls: true,
      toolContinuation: true,
      usage: true,
      thought: true,
      testedAt: "2026-08-14T00:00:00.000Z",
      reasoning: {
        acceptedNativeValues: [
          { effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" },
        ],
        nativeByProfile: {
          fast: { effort: "low" }, balanced: { effort: "medium" },
          deep: { effort: "high" }, max: { effort: "xhigh" },
        },
        capability: {
          control: "effort_levels",
          supportedProfiles: ["fast", "balanced", "deep", "max"],
          defaultProfile: "balanced",
          native: { parameter: "reasoning.effort", values: ["low", "medium", "high", "xhigh"] },
        },
      },
    });
    expect(partialSnapshot.reasoning).toEqual({
      acceptedNativeValues: [{ effort: "low" }, { effort: "high" }],
      nativeByProfile: { fast: { effort: "low" }, deep: { effort: "high" } },
      capability: {
        schemaVersion: 1,
        control: "effort_levels",
        adjustable: true,
        supportedProfiles: ["fast", "deep"],
        defaultProfile: "deep",
        native: { parameter: "reasoning.effort", values: ["low", "high"] },
      },
    });
    expect(guarded.every(/** 构造「toBe」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(url) => url.endsWith("/v1/responses"))).toBe(true);
    expect(JSON.stringify([fullSnapshot, partialSnapshot])).not.toContain("capability-test-secret");

    for (const server of [full, partial]) {
      expect(server.requests.every(/** 构造「toBe」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(request) =>
        request.headers.authorization === "Bearer capability-test-secret")).toBe(true);
      const effortRequests = server.requests.filter(/** 构造「effortRequests」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(request) => {
        const body = request.body;
        return Array.isArray(body.tools) && body.tools.length === 0 && body.reasoning !== undefined;
      });
      expect(effortRequests).toHaveLength(4);
      expect(effortRequests.map(/** 构造「toEqual」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(request) => (request.body.reasoning as { effort: string }).effort))
        .toEqual(["low", "medium", "high", "xhigh"]);
      expect(effortRequests.every(/** 构造「toBe」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(request) => request.body.max_output_tokens === 32)).toBe(true);
    }
  });

  it("任意模型名称也能由端点实测出 xhigh，且强制 Tool 完成两轮无副作用闭环", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const server = await start({
      supportedEfforts: ["low", "medium", "high", "xhigh"],
      model: "vendor-reasoner-v2",
    });
    const snapshot = await new ResponsesCapabilityProber({ timeoutMs: 2_000 }).probe(
      candidate(server.baseUrl, "vendor-reasoner-v2"),
    );

    expect(snapshot.reasoning.nativeByProfile.max).toEqual({ effort: "xhigh" });
    expect(snapshot.toolCalls).toBe(true);
    expect(snapshot.toolContinuation).toBe(true);
    const forced = server.requests.find(/** 构造「forced」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(request) => {
      const choice = request.body.tool_choice as { type?: string; name?: string } | undefined;
      return choice?.type === "function" && choice.name === "mk_capability_probe";
    });
    expect(forced?.body).toMatchObject({
      max_output_tokens: 256,
      tool_choice: { type: "function", name: "mk_capability_probe" },
    });
    expect(server.requests.some(/** 构造「toBe」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
(request) => JSON.stringify(request.body.input).includes("function_call_output")))
      .toBe(true);
  });

  it("端点若接受参数但回显了不同 effort，不把未生效的档位宣告为能力", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const server = await start({
      supportedEfforts: ["low", "medium", "high", "xhigh"],
      effectiveEffort: /** 构造「effectiveEffort」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => "low",
    });
    const snapshot = await new ResponsesCapabilityProber({ timeoutMs: 2_000 }).probe(
      candidate(server.baseUrl, "gpt-5.5"),
    );

    expect(snapshot.reasoning.acceptedNativeValues).toEqual([{ effort: "low" }]);
    expect(snapshot.reasoning.capability).toMatchObject({
      control: "fixed",
      adjustable: false,
      supportedProfiles: ["fast"],
      defaultProfile: "fast",
    });
    expect(snapshot.reasoning.nativeByProfile).toEqual({ fast: { effort: "low" } });
  });

  it("endpoint guard 拒绝时不发网络请求，且不重试", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const server = await start({ supportedEfforts: ["low", "medium", "high", "xhigh"] });
    const prober = new ResponsesCapabilityProber({
      endpointGuard: /** 构造「endpointGuard」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
() => { throw new Error("endpoint denied"); },
    });

    await expect(prober.probe(candidate(server.baseUrl, "gpt-5.5"))).rejects.toThrow("endpoint denied");
    expect(server.requests).toHaveLength(0);
  });

  it("入园体检也通过同一 endpointResolver 票据传输，不走 global fetch 二次 DNS", /** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */
async () => {
    const server = await start({ supportedEfforts: ["low", "medium", "high", "xhigh"] });
    const pinnedBaseUrl = new URL(server.baseUrl);
    pinnedBaseUrl.hostname = "probe-responses-rebinding.invalid";
    const resolver = vi.fn(/** 构造「resolver」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async (url: URL) => ({
      url: new URL(url),
      addresses: [{ address: "127.0.0.1", family: 4 as const }],
    }));
    const snapshot = await new ResponsesCapabilityProber({
      timeoutMs: 2_000,
      endpointResolver: resolver,
    }).probe(candidate(pinnedBaseUrl.toString(), "gpt-5.5"));

    expect(snapshot.streaming).toBe(true);
    expect(snapshot.toolContinuation).toBe(true);
    expect(resolver.mock.calls.length).toBe(server.requests.length);
    expect(resolver.mock.calls.every(/** 构造「toBe」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
([url]) => url.hostname === "probe-responses-rebinding.invalid"))
      .toBe(true);
  });
});

/** 构造「start」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
async function start(
  options: Parameters<typeof startResponsesCapabilityMockServer>[0],
): Promise<ResponsesCapabilityMockServer> {
  const server = await startResponsesCapabilityMockServer(options);
  servers.push(server);
  return server;
}

/** 构造「candidate」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */
function candidate(baseUrl: string, model: string): ResponsesModelCandidateInput {
  return {
    displayName: "大聪明",
    baseUrl,
    model,
    apiKey: "capability-test-secret",
  };
}
