import { describe, expect, it } from "vitest";
import type { ResolvedModelStudentCandidate } from "@kindergarten/contracts";
import {
  SiliconFlowCapabilityProber,
  connectionFingerprint,
} from "../src/model/siliconflow-capability-probe.js";
import { startChatCompletionsMockServer } from "./support/chat-completions-mock-server.js";

describe("SiliconFlowCapabilityProber", () => {
  it("主动确认文本、Tool 闭环、思考流、usage 与 enable_thinking toggle", async () => {
    const mock = await startChatCompletionsMockServer({ thinking: "toggle" });
    try {
      const candidate = resolvedCandidate(mock.baseUrl);
      const snapshot = await new SiliconFlowCapabilityProber({
        now: () => new Date("2026-08-14T00:00:00.000Z"),
      }).probe(candidate);

      expect(snapshot).toMatchObject({
        schemaVersion: 1,
        protocol: "openai_chat_completions",
        adapterRevision: "siliconflow-chat-completions-v1",
        probeVersion: 1,
        connectionFingerprint: connectionFingerprint(candidate),
        streaming: true,
        text: true,
        toolCalls: true,
        toolContinuation: true,
        usage: true,
        thought: true,
        reasoning: {
          capability: {
            control: "toggle",
            adjustable: true,
            supportedProfiles: ["fast", "balanced"],
            defaultProfile: "balanced",
            native: { parameter: "enable_thinking", values: [false, true] },
          },
          nativeByProfile: {
            fast: { enable_thinking: false },
            balanced: { enable_thinking: true },
          },
          acceptedNativeValues: [
            { enable_thinking: false },
            { enable_thinking: true },
          ],
        },
        testedAt: "2026-08-14T00:00:00.000Z",
      });
      expect(mock.requests.map((item) => item.body.enable_thinking)).toEqual([
        undefined,
        undefined,
        false,
        true,
        true,
        true,
      ]);
      expect(mock.requests.map((item) => item.body.stream_options)).toEqual([
        undefined,
        { include_usage: true },
        { include_usage: true },
        { include_usage: true },
        undefined,
        undefined,
      ]);
      expect(mock.requests.at(-1)?.body.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "assistant", tool_calls: expect.any(Array) }),
        expect.objectContaining({ role: "tool", tool_call_id: "call_probe" }),
      ]));
    } finally {
      await mock.close();
    }
  });

  it("同一 model ID 在忽略控制参数的端点只声明 fixed，不按名称或域名猜测", async () => {
    const toggleMock = await startChatCompletionsMockServer({ thinking: "toggle" });
    const ignoredMock = await startChatCompletionsMockServer({ thinking: "ignored" });
    try {
      const prober = new SiliconFlowCapabilityProber();
      const [toggle, ignored] = await Promise.all([
        prober.probe(resolvedCandidate(toggleMock.baseUrl)),
        prober.probe(resolvedCandidate(ignoredMock.baseUrl)),
      ]);

      expect(toggle.reasoning.capability.control).toBe("toggle");
      expect(ignored.reasoning).toEqual({
        capability: {
          schemaVersion: 1,
          control: "fixed",
          adjustable: false,
          supportedProfiles: ["balanced"],
          defaultProfile: "balanced",
        },
        nativeByProfile: { balanced: {} },
        acceptedNativeValues: [{}],
      });
      expect(toggle.connectionFingerprint).not.toBe(ignored.connectionFingerprint);
    } finally {
      await Promise.all([toggleMock.close(), ignoredMock.close()]);
    }
  });

  it("端点拒绝 enable_thinking 时仍可入园但不会虚报可调档位", async () => {
    const mock = await startChatCompletionsMockServer({ thinking: "rejected" });
    try {
      const snapshot = await new SiliconFlowCapabilityProber()
        .probe(resolvedCandidate(mock.baseUrl));
      expect(snapshot.reasoning.capability).toMatchObject({
        control: "fixed",
        adjustable: false,
        supportedProfiles: ["balanced"],
      });
      expect(snapshot.thought).toBe(false);
    } finally {
      await mock.close();
    }
  });

  it("Tool 请求成功但模型不返回调用时，不把请求被接受误判成 Tool 能力", async () => {
    const mock = await startChatCompletionsMockServer({ tools: false });
    try {
      const snapshot = await new SiliconFlowCapabilityProber()
        .probe(resolvedCandidate(mock.baseUrl));
      expect(snapshot.toolCalls).toBe(false);
      expect(snapshot.toolContinuation).toBe(false);
    } finally {
      await mock.close();
    }
  });

  it("fingerprint 不包含也不受 Secret 变化影响", () => {
    const first = resolvedCandidate("https://api.siliconflow.cn/v1");
    const second = { ...first, apiKey: "another-secret" };
    expect(connectionFingerprint(first)).toBe(connectionFingerprint(second));
    expect(connectionFingerprint(first)).toMatch(/^[a-f0-9]{64}$/);
  });
});

function resolvedCandidate(baseUrl: string): ResolvedModelStudentCandidate {
  return {
    presetId: "siliconflow",
    protocol: "openai_chat_completions",
    displayName: "Same model on endpoint",
    baseUrl,
    model: "same-model-id",
    apiKey: "test-token",
  };
}
